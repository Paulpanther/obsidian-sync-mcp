/**
 * MCP tools for Syncthing conflict copies (filesystem mode, CONFLICT_TOOLS=true).
 *
 * list_conflicts and diff_conflict are read-only. resolve_conflict writes the
 * result into the original (through the normal backend chain, so private-note
 * protection, backups and atomic writes apply), deletes the conflict copy only
 * after that write succeeded, and appends every action to a log note itself,
 * so the record never depends on the model remembering to write it.
 */

import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { contentHash, diffLines, findConflictPaths, formatDiff, parseConflictPath } from "./conflicts.js";
import { isPrivateContent } from "./vault-private.js";
import { isValidNotePath } from "./note-path.js";

export interface ConflictToolsOptions {
    /** Full backend chain used for reads and writes of notes. */
    vault: VaultBackend;
    /** Unguarded local backend: used to tell private conflict pairs apart and to write the log notes. */
    rawVault: VaultBackend;
    vaultRoot: string;
    vaultName: string;
    searchIndex: SearchIndex;
    readOnly: boolean;
    privateProperty: string | null;
    logNote: string;
    reviewNote: string;
    clock?: () => Date;
}

export const DEFAULT_CONFLICT_LOG_NOTE = "_system/Sync conflict log.md";
export const DEFAULT_CONFLICT_REVIEW_NOTE = "_system/Sync conflicts to review.md";

const LOG_HEADER = "# Sync conflict log\n\nWritten by the vault MCP server. One line per automatic conflict action; backups of overwritten or deleted files are in the server's backup folder.\n\n";
const REVIEW_HEADER = "# Sync conflicts to review\n\nConflicts the automatic routine did not resolve. Both files are still in the vault. Merge them by hand, then delete the conflict copy and tick the entry.\n\n";

export function registerConflictTools(server: FastMCP, opts: ConflictToolsOptions) {
    const { vault, rawVault, vaultRoot, vaultName, searchIndex, readOnly, privateProperty, logNote, reviewNote } = opts;
    const clock = opts.clock ?? (() => new Date());

    const isPrivate = (content: string | null) =>
        privateProperty !== null && content !== null && isPrivateContent(content, privateProperty);

    /** Read both sides raw. `hidden` is true when either side is a private note. */
    async function loadPair(conflictPath: string) {
        const name = parseConflictPath(conflictPath);
        if (!name) return null;
        // The note tools only touch real .md notes, so attachment conflicts
        // (images, PDFs, canvases) are listed but never read or changed.
        if (!isValidNotePath(conflictPath) || !isValidNotePath(name.original)) return { name, unsupported: true as const };
        const conflict = await rawVault.readNote(conflictPath);
        if (conflict === null) return null;
        const original = await rawVault.readNote(name.original);
        return { name, unsupported: false as const, conflict, original, hidden: isPrivate(conflict) || isPrivate(original) };
    }

    async function appendLine(notePath: string, header: string, line: string) {
        const existing = await rawVault.readNote(notePath);
        const base = existing ?? header;
        const next = (base.endsWith("\n") ? base : base + "\n") + line + "\n";
        const ok = await rawVault.writeNote(notePath, next);
        if (ok) searchIndex.update(notePath, next, Date.now());
        return ok;
    }

    server.addTool({
        name: "list_conflicts",
        description:
            "List Syncthing sync conflict copies (*.sync-conflict-*) in the vault, each paired with the note it conflicts with, plus content hashes to pass to resolve_conflict. Start every conflict cleanup here.",
        parameters: z.object({}),
        execute: async () => {
            const paths = await findConflictPaths(vaultRoot);
            const lines: string[] = [];
            const byHand: string[] = [];
            let skipped = 0;
            for (const p of paths) {
                const pair = await loadPair(p);
                if (!pair) continue;
                if (pair.unsupported) {
                    byHand.push(p);
                    continue;
                }
                if (pair.hidden) {
                    skipped++;
                    continue;
                }
                const { name, conflict, original } = pair;
                const orig = original === null
                    ? "original MISSING"
                    : `original ${name.original} (${original.length} chars, hash ${contentHash(original)})`;
                lines.push(
                    `- ${p}\n  ${orig}\n  conflict copy: ${conflict.length} chars, hash ${contentHash(conflict)}, from device ${name.device}, detected ${name.detected}`,
                );
            }
            let skippedNote = skipped > 0 ? ` ${skipped} conflict(s) involving private notes were skipped and must be resolved by hand.` : "";
            if (byHand.length > 0) skippedNote += ` ${byHand.length} conflict(s) on non-note files must be resolved by hand: ${byHand.join(", ")}.`;
            if (lines.length === 0) return `No sync conflicts found.${skippedNote}`;
            return [`${lines.length} sync conflict(s).${skippedNote}`, ...lines].join("\n");
        },
    });

    server.addTool({
        name: "diff_conflict",
        description:
            "Show a line diff between a conflict copy and its original note. Hunks are labelled only_in_conflict (the conflict copy added lines), only_in_original (the original has lines the copy lacks) or differs (both versions changed the same lines; usually needs escalation).",
        parameters: z.object({
            conflict_path: z.string().describe("Vault-relative path of the conflict copy, as listed by list_conflicts."),
        }),
        execute: async ({ conflict_path }) => {
            const pair = await loadPair(conflict_path);
            if (!pair) return `Conflict copy not found: ${conflict_path}`;
            if (pair.unsupported) return `Refused: ${conflict_path} is not a markdown note; resolve it by hand on a device.`;
            if (pair.hidden) return `Conflict copy not found: ${conflict_path}`;
            const { name, conflict, original } = pair;
            const header = [
                `Original: ${name.original}${original === null ? " (MISSING)" : ` (hash ${contentHash(original)})`}`,
                `Conflict copy: ${conflict_path} (hash ${contentHash(conflict)}, device ${name.device}, detected ${name.detected})`,
                "",
            ];
            if (original === null) {
                return header.join("\n") + "The original note no longer exists. Use resolve_conflict with action keep_conflict to restore it from the copy, or escalate.";
            }
            return header.join("\n") + formatDiff(diffLines(original, conflict));
        },
    });

    if (readOnly) return;

    server.addTool({
        name: "resolve_conflict",
        description:
            "Resolve one sync conflict. Actions: 'merge' writes merged_content into the original, then deletes the conflict copy; 'keep_original' deletes the conflict copy; 'keep_conflict' replaces the original with the conflict copy, then deletes the copy; 'escalate' changes nothing and adds the conflict to the review note. Pass the hashes from list_conflicts or diff_conflict; the call is refused if either file changed since. Every action is logged automatically and overwritten or deleted files are backed up. Escalate whenever both versions changed the same lines in contradicting ways.",
        parameters: z.object({
            conflict_path: z.string().describe("Vault-relative path of the conflict copy."),
            action: z.enum(["merge", "keep_original", "keep_conflict", "escalate"]),
            merged_content: z.string().optional().describe("Required for 'merge': the full merged note content."),
            expected_original_hash: z.string().optional().describe("Hash of the original from list_conflicts/diff_conflict. Required unless the original is missing."),
            expected_conflict_hash: z.string().describe("Hash of the conflict copy from list_conflicts/diff_conflict."),
            reason: z.string().min(1).max(500).describe("One sentence: why this action is correct. Written to the log."),
        }),
        execute: async ({ conflict_path, action, merged_content, expected_original_hash, expected_conflict_hash, reason }) => {
            const pair = await loadPair(conflict_path);
            if (!pair) return `Conflict copy not found: ${conflict_path}`;
            if (pair.unsupported) return `Refused: ${conflict_path} is not a markdown note; resolve it by hand on a device.`;
            if (pair.hidden) return `Conflict copy not found: ${conflict_path}`;
            const { name, conflict, original } = pair;
            const conflictHash = contentHash(conflict);
            const originalHash = original === null ? null : contentHash(original);
            if (conflictHash !== expected_conflict_hash || (originalHash !== null && originalHash !== expected_original_hash)) {
                return `Refused: a file changed since it was read (original now ${originalHash ?? "missing"}, conflict copy now ${conflictHash}). Run diff_conflict again.`;
            }
            const stamp = clock().toISOString().slice(0, 16).replace("T", " ");
            const where = `[[${name.original}]] vs \`${conflict_path}\` (device ${name.device})`;
            const oneLine = reason.replace(/\s+/g, " ").trim();

            if (action === "escalate") {
                // The daily routine sees the same open conflict again; list it only once.
                const review = await rawVault.readNote(reviewNote);
                if (review?.includes(`\`${conflict_path}\``)) {
                    return `Already escalated: ${conflict_path} is listed in ${reviewNote}. Nothing was changed.`;
                }
                await appendLine(reviewNote, REVIEW_HEADER, `- [ ] ${stamp} ${where}: ${oneLine}`);
                await appendLine(logNote, LOG_HEADER, `- ${stamp} **escalate** ${where}: ${oneLine}`);
                return `Escalated: ${conflict_path} added to ${reviewNote}. Nothing was changed.`;
            }

            let newOriginal: string | null;
            if (action === "merge") {
                if (merged_content === undefined) return "merged_content is required for action 'merge'.";
                newOriginal = merged_content;
            } else if (action === "keep_conflict") {
                newOriginal = conflict;
            } else {
                if (original === null) return "The original is missing; use keep_conflict to restore it from the copy, or escalate.";
                newOriginal = null; // keep_original: original stays as is
            }

            if (newOriginal !== null) {
                const wrote = await vault.writeNote(name.original, newOriginal);
                if (!wrote) return `Failed to write ${name.original}; the conflict copy was left in place.`;
                searchIndex.update(name.original, newOriginal, Date.now());
            }
            const deleted = await vault.deleteNote(conflict_path);
            if (deleted) searchIndex.remove(conflict_path);
            const after = newOriginal === null ? originalHash : contentHash(newOriginal);
            await appendLine(
                logNote,
                LOG_HEADER,
                `- ${stamp} **${action}** ${where}: ${oneLine} (original ${originalHash ?? "missing"} → ${after}${deleted ? "" : "; conflict copy NOT deleted"})`,
            );
            const link = makeDeepLink(vaultName, name.original);
            if (!deleted) return `Original updated, but deleting ${conflict_path} failed. Logged in ${logNote}.\n[Open in Obsidian](${link})`;
            return `Resolved (${action}): ${name.original}; conflict copy deleted. Logged in ${logNote}.\n[Open in Obsidian](${link})`;
        },
    });
}
