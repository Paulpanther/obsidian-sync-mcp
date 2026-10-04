import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { backupPathFor, backupVault, parseBackupDays, pruneBackups } from "./vault-backup.js";
import type { VaultBackend } from "./vault-backend.js";

const NOW = new Date("2026-10-04T13:05:09.123Z");

function memoryBackend(files: Record<string, string>): VaultBackend {
    return {
        init: async () => {},
        close: async () => {},
        readNote: async (p) => files[p] ?? null,
        writeNote: async (p, c) => { files[p] = c; return true; },
        deleteNote: async (p) => { delete files[p]; return true; },
        moveNote: async (f, t) => { files[t] = files[f]; delete files[f]; return true; },
        getMetadata: async () => null,
        listNotes: async () => Object.keys(files),
        listNotesWithMtime: async () => [],
    };
}

describe("parseBackupDays", () => {
    it("defaults to 30, accepts 0 to disable, ignores junk", () => {
        assert.equal(parseBackupDays(undefined), 30);
        assert.equal(parseBackupDays("7"), 7);
        assert.equal(parseBackupDays("0"), 0);
        assert.equal(parseBackupDays("-1"), 30);
        assert.equal(parseBackupDays("abc"), 30);
    });
});

describe("backupPathFor", () => {
    it("files a copy under the day folder with a time suffix", () => {
        assert.equal(backupPathFor("/b", "daily/note.md", NOW), "/b/2026-10-04/daily/note.md.130509-123");
    });
    it("refuses paths that escape the backup folder", () => {
        assert.equal(backupPathFor("/b", "../../etc/passwd", NOW), null);
    });
});

describe("backupVault", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "backup-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    it("copies the previous content before write, delete and move", async () => {
        const files: Record<string, string> = { "a.md": "v1", "b.md": "bee" };
        const v = backupVault(memoryBackend(files), dir, () => NOW);
        await v.writeNote("a.md", "v2");
        assert.equal(await readFile(join(dir, "2026-10-04/a.md.130509-123"), "utf-8"), "v1");
        await v.deleteNote("b.md");
        assert.equal(await readFile(join(dir, "2026-10-04/b.md.130509-123"), "utf-8"), "bee");
        assert.equal(files["a.md"], "v2");
        assert.equal(files["b.md"], undefined);
    });

    it("does not back up a note that does not exist yet", async () => {
        const v = backupVault(memoryBackend({}), dir, () => new Date("2026-10-05T00:00:00Z"));
        await v.writeNote("new.md", "x");
        assert.deepEqual(await readdir(dir).then((d) => d.includes("2026-10-05")), false);
    });
});

describe("pruneBackups", () => {
    it("removes day folders older than the retention and keeps the rest", async () => {
        const dir = await mkdtemp(join(tmpdir(), "prune-"));
        for (const d of ["2026-08-01", "2026-09-10", "2026-10-03", "notes"]) await mkdir(join(dir, d));
        const removed = await pruneBackups(dir, 30, NOW);
        assert.deepEqual(removed, ["2026-08-01"]);
        assert.deepEqual((await readdir(dir)).sort(), ["2026-09-10", "2026-10-03", "notes"]);
        await rm(dir, { recursive: true, force: true });
    });
    it("returns nothing for a missing folder", async () => {
        assert.deepEqual(await pruneBackups("/nonexistent-backup-dir", 30, NOW), []);
    });
});
