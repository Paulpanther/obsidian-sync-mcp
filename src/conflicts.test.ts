import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { contentHash, diffLines, findConflictPaths, formatDiff, isConflictPath, parseConflictPath } from "./conflicts.js";

describe("parseConflictPath", () => {
    it("parses a Syncthing conflict copy of a markdown note", () => {
        assert.deepEqual(parseConflictPath("daily/2026-10-03.sync-conflict-20261003-101010-ABCDEFG.md"), {
            path: "daily/2026-10-03.sync-conflict-20261003-101010-ABCDEFG.md",
            original: "daily/2026-10-03.md",
            device: "ABCDEFG",
            detected: "2026-10-03T10:10:10Z",
        });
    });
    it("handles files without extension and dotted names", () => {
        assert.equal(parseConflictPath("todo.sync-conflict-20261003-101010-ABCDEFG")?.original, "todo");
        assert.equal(parseConflictPath("v1.2 notes.sync-conflict-20261003-101010-ABCDEFG.md")?.original, "v1.2 notes.md");
    });
    it("rejects ordinary notes", () => {
        assert.equal(parseConflictPath("notes/sync-conflict.md"), null);
        assert.equal(isConflictPath("a.md"), false);
    });
});

describe("findConflictPaths", () => {
    it("finds conflict copies of any extension and skips dot folders", async () => {
        const root = await mkdtemp(join(tmpdir(), "conflicts-"));
        await mkdir(join(root, "a/b"), { recursive: true });
        await mkdir(join(root, ".stversions"), { recursive: true });
        await writeFile(join(root, "a/b/n.md"), "x");
        await writeFile(join(root, "a/b/n.sync-conflict-20261003-101010-ABCDEFG.md"), "y");
        await writeFile(join(root, "img.sync-conflict-20261003-101010-ABCDEFG.png"), "z");
        await writeFile(join(root, ".stversions/n.sync-conflict-20261003-101010-ABCDEFG.md"), "old");
        assert.deepEqual(await findConflictPaths(root), [
            "a/b/n.sync-conflict-20261003-101010-ABCDEFG.md",
            "img.sync-conflict-20261003-101010-ABCDEFG.png",
        ]);
        await rm(root, { recursive: true, force: true });
    });
});

describe("contentHash", () => {
    it("is stable and changes with content", () => {
        assert.equal(contentHash("a"), contentHash("a"));
        assert.notEqual(contentHash("a"), contentHash("b"));
        assert.equal(contentHash("a").length, 16);
    });
});

describe("diffLines", () => {
    it("reports identical texts, ignoring line endings", () => {
        assert.equal(diffLines("a\nb\n", "a\r\nb").identical, true);
    });
    it("labels added, removed and changed hunks", () => {
        const r = diffLines("one\ntwo\nthree\nfour\n", "one\nTWO\nthree\nfour\nfive\n");
        assert.deepEqual(r.hunks.map((h) => h.kind), ["differs", "only_in_conflict"]);
        assert.deepEqual(r.hunks[0], { kind: "differs", originalLine: 2, conflictLine: 2, removed: ["two"], added: ["TWO"] });
        assert.deepEqual(r.hunks[1].added, ["five"]);
        assert.equal(r.linesOnlyInOriginal, 1);
        assert.equal(r.linesOnlyInConflict, 2);
        const removed = diffLines("a\nb\nc\n", "a\nc\n");
        assert.deepEqual(removed.hunks.map((h) => h.kind), ["only_in_original"]);
    });
    it("formats a readable diff with a summary", () => {
        const text = formatDiff(diffLines("a\nb\n", "a\nc\nd\n"));
        assert.match(text, /^1 hunk\(s\): 0 only in the conflict copy, 0 only in the original, 1 where both versions differ/);
        assert.match(text, /- b\n\+ c\n\+ d/);
        assert.equal(formatDiff(diffLines("x", "x")), "The two versions are identical (ignoring line endings).");
    });
});
