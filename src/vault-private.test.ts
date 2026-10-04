import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPrivateContent, parsePrivateProperty, privateNotesVault } from "./vault-private.js";
import type { VaultBackend } from "./vault-backend.js";

describe("isPrivateContent", () => {
    it("detects truthy private values in frontmatter", () => {
        for (const v of ["true", "True", "yes", "on", '"true"', "'yes'", "true # keep out"]) {
            assert.equal(isPrivateContent(`---\nprivate: ${v}\n---\nbody`), true, v);
        }
    });

    it("ignores false values, other keys and body text", () => {
        assert.equal(isPrivateContent("---\nprivate: false\n---\n"), false);
        assert.equal(isPrivateContent("---\nprivate:\n---\n"), false);
        assert.equal(isPrivateContent("---\nnot_private: true\n---\n"), false);
        assert.equal(isPrivateContent("private: true\n"), false);
        assert.equal(isPrivateContent("# Note\n---\nprivate: true\n---\n"), false);
        assert.equal(isPrivateContent("---\ntitle: x\n"), false, "unclosed frontmatter");
    });

    it("handles CRLF, a BOM and a custom property name", () => {
        assert.equal(isPrivateContent("﻿---\r\ntitle: a\r\nprivate: true\r\n---\r\nbody"), true);
        assert.equal(isPrivateContent("---\nsecret: yes\n---\n", "secret"), true);
        assert.equal(isPrivateContent("---\nprivate: yes\n---\n", "secret"), false);
    });
});

describe("parsePrivateProperty", () => {
    it("defaults to 'private' and disables on empty string", () => {
        assert.equal(parsePrivateProperty(undefined), "private");
        assert.equal(parsePrivateProperty(" secret "), "secret");
        assert.equal(parsePrivateProperty(""), null);
    });
});

function memoryBackend(files: Record<string, string>) {
    const calls: string[] = [];
    const backend: VaultBackend = {
        init: async () => {},
        close: async () => {},
        readNote: async (p) => files[p] ?? null,
        writeNote: async (p, c) => { calls.push(`write:${p}`); files[p] = c; return true; },
        deleteNote: async (p) => { calls.push(`delete:${p}`); delete files[p]; return true; },
        moveNote: async (f, t) => { calls.push(`move:${f}->${t}`); files[t] = files[f]; delete files[f]; return true; },
        getMetadata: async (p) => (p in files ? { path: p, size: 1, ctime: 0, mtime: 0, frontmatter: {}, tags: [], links: [] } : null),
        listNotes: async () => Object.keys(files),
        listNotesWithMtime: async () => Object.keys(files).map((path) => ({ path, mtime: 1 })),
    };
    return { backend, calls, files };
}

const SECRET = "---\nprivate: true\n---\nsecret diary";

describe("privateNotesVault", () => {
    it("reads and metadata answer as if a private note did not exist", async () => {
        const { backend } = memoryBackend({ "a.md": "public", "s.md": SECRET });
        const v = privateNotesVault(backend);
        assert.equal(await v.readNote("a.md"), "public");
        assert.equal(await v.readNote("s.md"), null);
        assert.equal(await v.getMetadata("s.md"), null);
        assert.ok(await v.getMetadata("a.md"));
    });

    it("leaves private notes out of listings", async () => {
        const { backend } = memoryBackend({ "a.md": "public", "s.md": SECRET });
        const v = privateNotesVault(backend);
        assert.deepEqual(await v.listNotes(), ["a.md"]);
        assert.deepEqual((await v.listNotesWithMtime()).map((n) => n.path), ["a.md"]);
    });

    it("refuses to write, delete or move private notes without touching the backend", async () => {
        const { backend, calls, files } = memoryBackend({ "a.md": "public", "s.md": SECRET });
        const v = privateNotesVault(backend);
        assert.equal(await v.writeNote("s.md", "overwritten"), false);
        assert.equal(await v.deleteNote("s.md"), false);
        assert.equal(await v.moveNote("s.md", "b.md"), false);
        assert.equal(await v.moveNote("a.md", "s.md"), false, "moving onto a private note");
        assert.deepEqual(calls, []);
        assert.equal(files["s.md"], SECRET);
    });

    it("still allows writes to public and new notes", async () => {
        const { backend, calls } = memoryBackend({ "a.md": "public" });
        const v = privateNotesVault(backend);
        assert.equal(await v.writeNote("a.md", "changed"), true);
        assert.equal(await v.writeNote("new.md", "x"), true);
        assert.equal(await v.moveNote("a.md", "b.md"), true);
        assert.deepEqual(calls, ["write:a.md", "write:new.md", "move:a.md->b.md"]);
    });

    it("turns private notes in remote change feeds into deletes", async () => {
        const { backend } = memoryBackend({});
        const seen: Array<[string, string | null]> = [];
        backend.watchChanges = (cb) => { cb("a.md", "public", 1, 1); cb("s.md", SECRET, 1, 2); };
        backend.catchUp = async (_since, cb) => { cb("s.md", SECRET, 1); cb("gone.md", null, 1); return "9"; };
        const v = privateNotesVault(backend);
        v.watchChanges!((p, c) => seen.push([p, c]));
        assert.equal(await v.catchUp!("0", (p, c) => seen.push([p, c])), "9");
        assert.deepEqual(seen, [["a.md", "public"], ["s.md", null], ["s.md", null], ["gone.md", null]]);
    });
});
