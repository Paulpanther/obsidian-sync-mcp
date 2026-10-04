/**
 * Syncthing conflict files: find them, diff them against their original.
 *
 * Syncthing keeps both versions when a file changed on two devices, naming
 * the losing copy `<name>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<DEVICE>.<ext>`
 * next to the original. These helpers are filesystem-mode only and
 * dependency-light so they are unit-testable in isolation.
 */

import { readdir } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { diff_match_patch } from "diff-match-patch";

const CONFLICT_RE = /^(.*)\.sync-conflict-(\d{8})-(\d{6})-([A-Z0-9]{7})(\.[^/]*)?$/;

export interface ConflictName {
    /** Vault-relative path of the conflict copy. */
    path: string;
    /** Vault-relative path of the note it conflicts with. */
    original: string;
    /** Short Syncthing device ID of the device whose change lost. */
    device: string;
    /** When Syncthing detected the conflict, ISO 8601 (UTC as recorded by Syncthing). */
    detected: string;
}

/** Parse a conflict copy's path, or null if it is not one. */
export function parseConflictPath(path: string): ConflictName | null {
    const m = path.match(CONFLICT_RE);
    if (!m) return null;
    const [, base, date, time, device, ext = ""] = m;
    // Syncthing appends the marker before the *last* extension only.
    const detected = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
    return { path, original: base + ext, device, detected };
}

export function isConflictPath(path: string): boolean {
    return CONFLICT_RE.test(path);
}

/** Recursively list vault-relative paths of all conflict copies, skipping dot folders and dot files. */
export async function findConflictPaths(root: string, dir = ""): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await findConflictPaths(root, rel)));
        else if (e.isFile() && isConflictPath(rel)) out.push(rel);
    }
    return out.sort();
}

/** Short content hash used as an optimistic-concurrency token. */
export function contentHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

export type HunkKind = "only_in_original" | "only_in_conflict" | "differs";

export interface DiffHunk {
    kind: HunkKind;
    /** 1-based line in the original where the hunk starts. */
    originalLine: number;
    /** 1-based line in the conflict copy where the hunk starts. */
    conflictLine: number;
    removed: string[];
    added: string[];
}

export interface DiffResult {
    identical: boolean;
    hunks: DiffHunk[];
    linesOnlyInOriginal: number;
    linesOnlyInConflict: number;
}

function splitLines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/** Line-based diff of an original note against its conflict copy, grouped into hunks. */
export function diffLines(original: string, conflict: string): DiffResult {
    const dmp = new diff_match_patch();
    // Normalize line endings so CRLF vs LF is not reported as a change.
    const a = splitLines(original).join("\n") + "\n";
    const b = splitLines(conflict).join("\n") + "\n";
    const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
    const diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);

    const hunks: DiffHunk[] = [];
    let lineA = 1;
    let lineB = 1;
    let current: DiffHunk | null = null;
    let removedTotal = 0;
    let addedTotal = 0;
    for (const [op, text] of diffs) {
        const lines = splitLines(text);
        if (op === 0) {
            if (current) hunks.push(current);
            current = null;
            lineA += lines.length;
            lineB += lines.length;
            continue;
        }
        if (!current) current = { kind: "differs", originalLine: lineA, conflictLine: lineB, removed: [], added: [] };
        if (op === -1) {
            current.removed.push(...lines);
            lineA += lines.length;
            removedTotal += lines.length;
        } else {
            current.added.push(...lines);
            lineB += lines.length;
            addedTotal += lines.length;
        }
    }
    if (current) hunks.push(current);
    for (const h of hunks) {
        h.kind = h.added.length === 0 ? "only_in_original" : h.removed.length === 0 ? "only_in_conflict" : "differs";
    }
    return { identical: hunks.length === 0, hunks, linesOnlyInOriginal: removedTotal, linesOnlyInConflict: addedTotal };
}

/** Render a diff for an LLM: a summary line, then each hunk with -/+ lines. */
export function formatDiff(result: DiffResult, maxLines = 400): string {
    if (result.identical) return "The two versions are identical (ignoring line endings).";
    const counts = { only_in_original: 0, only_in_conflict: 0, differs: 0 };
    for (const h of result.hunks) counts[h.kind]++;
    const out = [
        `${result.hunks.length} hunk(s): ${counts.only_in_conflict} only in the conflict copy, ${counts.only_in_original} only in the original, ${counts.differs} where both versions differ on the same lines.`,
        `Lines only in original: ${result.linesOnlyInOriginal}. Lines only in conflict copy: ${result.linesOnlyInConflict}.`,
    ];
    let emitted = 0;
    result.hunks.forEach((h, i) => {
        if (emitted >= maxLines) return;
        out.push("", `@@ hunk ${i + 1} (${h.kind}) original line ${h.originalLine}, conflict line ${h.conflictLine} @@`);
        for (const l of h.removed) { if (emitted++ < maxLines) out.push(`- ${l}`); }
        for (const l of h.added) { if (emitted++ < maxLines) out.push(`+ ${l}`); }
    });
    if (emitted >= maxLines) out.push("", `(diff truncated at ${maxLines} lines; read both files for the rest)`);
    return out.join("\n");
}
