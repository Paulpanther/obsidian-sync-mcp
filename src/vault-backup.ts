/**
 * Backup before every write.
 *
 * Wraps a backend so that writeNote, deleteNote and moveNote first copy the
 * note's current content into BACKUP_DIR/<YYYY-MM-DD>/<path>.<HHMMSS-mmm>.
 * Nothing is copied for a note that does not exist yet. Old backup days are
 * pruned after BACKUP_DAYS. Makes a whole-vault write scope safe to undo.
 */

import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";
import type { VaultBackend } from "./vault-backend.js";

export const DEFAULT_BACKUP_DAYS = 30;

/** Parse BACKUP_DAYS: unset means the default, 0 disables backups. Invalid values fall back to the default. */
export function parseBackupDays(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") return DEFAULT_BACKUP_DAYS;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_BACKUP_DAYS;
}

/** Path of the backup copy for a vault-relative note at a given time, or null if the path would escape the backup dir. */
export function backupPathFor(backupDir: string, notePath: string, now: Date): string | null {
    const iso = now.toISOString(); // 2026-10-04T13:05:09.123Z
    const day = iso.slice(0, 10);
    const time = iso.slice(11, 23).replace(/:/g, "").replace(".", "-"); // 130509-123
    const root = resolve(backupDir, day);
    const full = resolve(root, `${notePath.replace(/^\/+/, "")}.${time}`);
    return full.startsWith(root + sep) ? full : null;
}

/** Delete day folders (YYYY-MM-DD) older than `days` days. Returns the removed folder names. */
export async function pruneBackups(backupDir: string, days: number, now: Date = new Date()): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(backupDir);
    } catch {
        return [];
    }
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const removed: string[] = [];
    for (const name of entries) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) {
            await rm(resolve(backupDir, name), { recursive: true, force: true });
            removed.push(name);
        }
    }
    return removed;
}

/** Return a backend that backs up a note's previous content before changing it. */
export function backupVault(inner: VaultBackend, backupDir: string, clock: () => Date = () => new Date()): VaultBackend {
    const backup = async (path: string): Promise<void> => {
        let content: string | null;
        try {
            content = await inner.readNote(path);
        } catch {
            return; // invalid path: the inner backend rejects the write itself
        }
        if (content === null) return;
        const target = backupPathFor(backupDir, path, clock());
        if (!target) return;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: "utf-8", mode: 0o600 });
    };
    const wrapped: VaultBackend = {
        init: () => inner.init(),
        close: () => inner.close(),
        readNote: (path) => inner.readNote(path),
        getMetadata: (path) => inner.getMetadata(path),
        listNotes: (folder) => inner.listNotes(folder),
        listNotesWithMtime: (folder) => inner.listNotesWithMtime(folder),
        writeNote: async (path, content) => {
            await backup(path);
            return inner.writeNote(path, content);
        },
        deleteNote: async (path) => {
            await backup(path);
            return inner.deleteNote(path);
        },
        moveNote: async (from, to) => {
            await backup(from);
            await backup(to);
            return inner.moveNote(from, to);
        },
    };
    if (inner.watchChanges) wrapped.watchChanges = inner.watchChanges.bind(inner);
    if (inner.catchUp) wrapped.catchUp = inner.catchUp.bind(inner);
    return wrapped;
}
