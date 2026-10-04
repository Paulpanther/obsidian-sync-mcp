/**
 * Private notes: a note whose frontmatter sets the private property
 * (`private: true` by default) is invisible to every tool.
 *
 * Enforced at the backend layer, like READ_ONLY, so every tool (and the
 * search index, which is fed through the same backend) goes through it:
 * reads answer as if the note did not exist, writes that would touch a
 * private note fail, and listings leave private notes out. The check reads
 * the note at call time, so a note marked private is hidden immediately,
 * not only after the index catches up.
 * Kept dependency-free so it is unit-testable in isolation.
 */

import type { VaultBackend, NoteListing } from "./vault-backend.js";

export const DEFAULT_PRIVATE_PROPERTY = "private";

const TRUE_VALUES = new Set(["true", "yes", "on"]);

/** Parse the PRIVATE_PROPERTY env var: unset means the default, "" disables the feature. */
export function parsePrivateProperty(raw: string | undefined): string | null {
    if (raw === undefined) return DEFAULT_PRIVATE_PROPERTY;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
}

/** True when the note's frontmatter sets `<property>` to a truthy value (true, yes, on; quotes and case ignored). */
export function isPrivateContent(content: string, property: string = DEFAULT_PRIVATE_PROPERTY): boolean {
    const text = content.startsWith("﻿") ? content.slice(1) : content;
    const open = text.match(/^---[ \t]*\r?\n/);
    if (!open) return false;
    const rest = text.slice(open[0].length);
    const close = rest.match(/^(?:---|\.\.\.)[ \t]*$/m);
    if (!close || close.index === undefined) return false;
    const yaml = rest.slice(0, close.index);
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = yaml.match(new RegExp(`^${escaped}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, "m"));
    if (!line) return false;
    const value = line[1].replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
    return TRUE_VALUES.has(value);
}

/** Return a backend that hides private notes from every caller. */
export function privateNotesVault(inner: VaultBackend, property: string = DEFAULT_PRIVATE_PROPERTY): VaultBackend {
    const isPrivate = async (path: string): Promise<boolean> => {
        let content: string | null;
        try {
            content = await inner.readNote(path);
        } catch {
            return false; // invalid path: let the inner backend report it
        }
        return content !== null && isPrivateContent(content, property);
    };
    const visible = async (notes: NoteListing[]): Promise<NoteListing[]> => {
        const flags = await Promise.all(notes.map((n) => isPrivate(n.path)));
        return notes.filter((_, i) => !flags[i]);
    };
    const filterChange = (content: string | null): string | null =>
        content !== null && isPrivateContent(content, property) ? null : content;

    const wrapped: VaultBackend = {
        init: () => inner.init(),
        close: () => inner.close(),
        readNote: async (path) => {
            const content = await inner.readNote(path);
            return filterChange(content);
        },
        getMetadata: async (path) => ((await isPrivate(path)) ? null : inner.getMetadata(path)),
        writeNote: async (path, content) => ((await isPrivate(path)) ? false : inner.writeNote(path, content)),
        deleteNote: async (path) => ((await isPrivate(path)) ? false : inner.deleteNote(path)),
        moveNote: async (from, to) => {
            if ((await isPrivate(from)) || (await isPrivate(to))) return false;
            return inner.moveNote(from, to);
        },
        listNotes: async (folder) => (await visible(await inner.listNotesWithMtime(folder))).map((n) => n.path),
        listNotesWithMtime: async (folder) => visible(await inner.listNotesWithMtime(folder)),
    };
    // Remote change feeds: a note that is (or became) private reaches the index as a delete.
    if (inner.watchChanges) {
        wrapped.watchChanges = (callback) =>
            inner.watchChanges!((path, content, mtime, seq) => callback(path, filterChange(content), mtime, seq));
    }
    if (inner.catchUp) {
        wrapped.catchUp = (since, callback, onBatch) =>
            inner.catchUp!(since, (path, content, mtime) => callback(path, filterChange(content), mtime), onBatch);
    }
    return wrapped;
}
