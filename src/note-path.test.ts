import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateNotePath, isValidNotePath } from "./note-path.js";

describe("validateNotePath", () => {
    it("accepts ordinary note paths", () => {
        for (const p of ["note.md", "daily/2026-03-23.md", "a/b/c/deep note.md", "Проект/заметка.md"]) {
            assert.doesNotThrow(() => validateNotePath(p), p);
        }
    });

    it("rejects paths that are not .md (LiveSync control docs, attachments, code)", () => {
        for (const p of ["obsydian_livesync_version", "note.txt", "drawing.canvas", "image.png", "folder/data.json"]) {
            assert.throws(() => validateNotePath(p), /Invalid note path/, p);
        }
    });

    it("rejects LiveSync id prefixes via the colon rule", () => {
        for (const p of ["ix:00abc", "ps:deadbeef", "h:chunk.md"]) {
            assert.throws(() => validateNotePath(p), /Invalid note path/, p);
        }
    });

    it("rejects hidden / dot-folder paths even when they end in .md", () => {
        for (const p of [
            ".obsidian/plugins/evil/main.js",
            ".obsidian/plugins/obsidian-livesync/data.json",
            ".obsidian/config.md",
            ".hidden.md",
            "notes/.secret.md",
            ".trash/old.md",
        ]) {
            assert.throws(() => validateNotePath(p), /Invalid note path/, p);
        }
    });

    it("rejects traversal, absolute, NUL, and empty segments", () => {
        for (const p of ["../escape.md", "a/../../etc/passwd.md", "/abs/note.md", "a\0b.md", "a//b.md", "folder/.md"]) {
            assert.throws(() => validateNotePath(p), /Invalid note path/, p);
        }
    });

    it("rejects empty and over-long paths", () => {
        assert.throws(() => validateNotePath(""), /Invalid note path/);
        assert.throws(() => validateNotePath("a".repeat(1001) + ".md"), /Invalid note path/);
    });

    it("rejects LiveSync control flag files at the root (any case)", () => {
        for (const p of ["redflag.md", "redflag2.md", "redflag3.md", "flag_rebuild.md", "flag_fetch.md", "REDFLAG2.md"]) {
            assert.throws(() => validateNotePath(p), /reserved LiveSync control file/, p);
        }
    });

    it("allows a note that merely shares a flag-file name inside a folder", () => {
        assert.doesNotThrow(() => validateNotePath("notes/redflag2.md"));
    });

    it("rejects backslash dot-segments (Windows hidden dirs)", () => {
        assert.throws(() => validateNotePath("sub\\.obsidian\\evil.md"), /Invalid note path/);
    });
});

describe("isValidNotePath", () => {
    it("is the boolean form of validateNotePath", () => {
        assert.equal(isValidNotePath("daily/note.md"), true);
        assert.equal(isValidNotePath(".obsidian/x.md"), false);
        assert.equal(isValidNotePath("redflag2.md"), false);
        assert.equal(isValidNotePath("note.txt"), false);
    });
});
