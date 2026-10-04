/**
 * E2E test for the fork's additions: search_notes, private notes, backups and
 * the conflict tools. Starts the server in filesystem mode and drives it over MCP.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";

const PORT = 9878;
const BASE = `http://localhost:${PORT}/mcp`;
const AUTH = "ci-test-token";
const CONFLICT = "notes/plan.sync-conflict-20261003-101010-ABCDEFG.md";
const SECRET_CONFLICT = "diary.sync-conflict-20261003-111111-ABCDEFG.md";

let server: ChildProcess;
let vaultDir: string;
let dataDir: string;
let sessionId = "";
let logs = "";

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

async function post(method: string, params: any, id = 1) {
    return fetch(BASE, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": `Bearer ${AUTH}`,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
}

/** Every tool response, so the private-note test can check none of them leaked anything. */
const transcript: string[] = [];

async function callTool(name: string, args: any = {}): Promise<string> {
    const resp = parseSSE(await (await post("tools/call", { name, arguments: args })).text());
    const text = resp?.result?.content?.[0]?.text;
    assert.ok(text, `Tool ${name} returned no text: ${JSON.stringify(resp).slice(0, 300)}`);
    transcript.push(text);
    return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "vault-features-"));
    dataDir = await mkdtemp(join(tmpdir(), "data-features-"));
    await mkdir(join(vaultDir, "notes"), { recursive: true });
    await writeFile(join(vaultDir, "notes/plan.md"), "# Plan\n- buy milk\n- call Anna\n");
    await writeFile(join(vaultDir, CONFLICT), "# Plan\n- buy milk\n- call Anna\n- book train\n");
    await writeFile(join(vaultDir, "notes/other.md"), "Nothing here about groceries. [[plan]]\n#public");
    await writeFile(join(vaultDir, "diary.md"), "---\nprivate: true\n---\nsecret diary about milk [[plan]]\n#hidden");
    await writeFile(join(vaultDir, SECRET_CONFLICT), "---\nprivate: true\n---\nsecret diary v2");

    server = spawn("node", ["dist/main.js"], {
        env: {
            ...process.env,
            PORT: String(PORT),
            MCP_AUTH_TOKEN: AUTH,
            VAULT_PATH: vaultDir,
            VAULT_NAME: "FeatureVault",
            DATA_DIR: dataDir,
            CONFLICT_TOOLS: "true",
        },
        stdio: "pipe",
    });
    server.stdout?.on("data", (d) => { logs += d.toString(); });
    server.stderr?.on("data", (d) => { logs += d.toString(); });
    const start = Date.now();
    while (Date.now() - start < 10000) {
        try {
            const resp = await post("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 0);
            if (resp.ok) {
                sessionId = resp.headers.get("mcp-session-id") ?? "";
                await resp.text();
                break;
            }
        } catch { /* not ready */ }
        await sleep(200);
    }
    assert.ok(sessionId, `server did not start:\n${logs}`);
    // Let the startup index build finish.
    for (let i = 0; i < 50 && !logs.includes("Search index built"); i++) await sleep(100);
});

after(async () => {
    server?.kill("SIGTERM");
    await sleep(500);
    await rm(vaultDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
});

describe("E2E: search_notes", () => {
    it("finds notes by content with line numbers, skipping conflict copies by default", async () => {
        const text = await callTool("search_notes", { query: "milk" });
        assert.match(text, /^Found 1 note\(s\) matching "milk"/);
        assert.match(text, /notes\/plan\.md/);
        assert.match(text, / {2}2: - buy milk/);
        assert.doesNotMatch(text, /sync-conflict/);
    });

    it("includes conflict copies on request and supports regex", async () => {
        const text = await callTool("search_notes", { query: "book\\s+train", regex: true, include_conflicts: true });
        assert.match(text, /plan\.sync-conflict-20261003-101010-ABCDEFG\.md/);
        assert.match(await callTool("search_notes", { query: "(" , regex: true }), /^Invalid regular expression/);
    });

    it("says clearly when nothing matches", async () => {
        assert.match(await callTool("search_notes", { query: "zebra" }), /^No notes contain "zebra"/);
    });
});

describe("E2E: private notes", () => {
    it("answers reads of a private note as not found", async () => {
        assert.equal(await callTool("read_note", { path: "diary.md" }), "Note not found: diary.md");
        assert.equal(await callTool("get_note_metadata", { path: "diary.md" }), "Note not found: diary.md");
        assert.equal(await callTool("edit_note", { path: "diary.md", content: "x" }), "Note not found: diary.md");
        assert.equal(await callTool("delete_note", { path: "diary.md" }), "Note not found: diary.md");
    });

    it("refuses to overwrite or move a private note", async () => {
        assert.match(await callTool("write_note", { path: "diary.md", content: "overwritten" }), /^Failed to write note/);
        assert.match(await callTool("move_note", { from: "diary.md", to: "moved.md" }), /^Failed to move/);
        assert.match(await callTool("move_note", { from: "notes/other.md", to: "diary.md" }), /^Failed to move/);
        assert.match(await readFile(join(vaultDir, "diary.md"), "utf-8"), /secret diary about milk/);
    });

    it("leaves private notes out of listings, tags, backlinks, search and conflicts", async () => {
        transcript.length = 0; // earlier probes name the private path on purpose
        await callTool("list_notes", {});
        await callTool("list_folders", {});
        await callTool("list_tags", {});
        await callTool("get_note_metadata", { path: "notes/plan.md" });
        assert.match(await callTool("search_notes", { query: "secret" }), /^No notes contain/);
        assert.match(await callTool("search_notes", { query: "secret", include_conflicts: true }), /^No notes contain/);
        const conflicts = await callTool("list_conflicts", {});
        assert.match(conflicts, /1 conflict\(s\) involving private notes were skipped/);
        for (const text of transcript) {
            assert.doesNotMatch(text, /diary|secret diary|#hidden|hidden \(/, `leaked in: ${text.slice(0, 200)}`);
        }
        assert.match(await callTool("diff_conflict", { conflict_path: SECRET_CONFLICT }), /^Conflict copy not found/);
    });

    it("hides a note as soon as it is marked private on disk", async () => {
        assert.match(await callTool("read_note", { path: "notes/other.md" }), /groceries/);
        await writeFile(join(vaultDir, "notes/other.md"), "---\nprivate: yes\n---\nNow private.");
        await sleep(400);
        assert.equal(await callTool("read_note", { path: "notes/other.md" }), "Note not found: notes/other.md");
        assert.doesNotMatch(await callTool("list_notes", {}), /other\.md/);
        await writeFile(join(vaultDir, "notes/other.md"), "Public again. [[plan]]\n#public");
        await sleep(400);
    });
});

describe("E2E: backups", () => {
    it("keeps the previous content of an edited note in .mcp-backups", async () => {
        await callTool("edit_note", { path: "notes/other.md", content: "appended line" });
        const day = new Date().toISOString().slice(0, 10);
        const files = await readdir(join(vaultDir, ".mcp-backups", day, "notes"));
        const copy = files.find((f) => f.startsWith("other.md."));
        assert.ok(copy, `no backup in ${files}`);
        assert.match(await readFile(join(vaultDir, ".mcp-backups", day, "notes", copy!), "utf-8"), /^Public again/);
        assert.doesNotMatch(await callTool("list_notes", {}), /mcp-backups/);
    });
});

describe("E2E: conflict tools", () => {
    let originalHash = "";
    let conflictHash = "";

    it("lists the conflict with its original and hashes", async () => {
        const text = await callTool("list_conflicts", {});
        assert.match(text, /^1 sync conflict\(s\)/);
        assert.match(text, new RegExp(`- ${CONFLICT.replace(/\./g, "\\.")}`));
        originalHash = text.match(/original notes\/plan\.md \(\d+ chars, hash ([0-9a-f]{16})\)/)![1];
        conflictHash = text.match(/conflict copy: \d+ chars, hash ([0-9a-f]{16})/)![1];
        assert.match(text, /from device ABCDEFG, detected 2026-10-03T10:10:10Z/);
    });

    it("diffs the conflict copy against the original", async () => {
        const text = await callTool("diff_conflict", { conflict_path: CONFLICT });
        assert.match(text, /1 hunk\(s\): 1 only in the conflict copy/);
        assert.match(text, /\+ - book train/);
    });

    it("refuses to resolve when a hash is stale", async () => {
        const text = await callTool("resolve_conflict", {
            conflict_path: CONFLICT, action: "keep_conflict", expected_original_hash: "0000000000000000",
            expected_conflict_hash: conflictHash, reason: "test",
        });
        assert.match(text, /^Refused: a file changed since it was read/);
        assert.ok(existsSync(join(vaultDir, CONFLICT)));
    });

    it("escalates once, without changing files", async () => {
        const args = { conflict_path: CONFLICT, action: "escalate", expected_original_hash: originalHash, expected_conflict_hash: conflictHash, reason: "Checking escalation." };
        assert.match(await callTool("resolve_conflict", args), /^Escalated/);
        assert.match(await callTool("resolve_conflict", args), /^Already escalated/);
        const review = await readFile(join(vaultDir, "_system/Sync conflicts to review.md"), "utf-8");
        assert.equal(review.split(CONFLICT).length - 1, 1);
        assert.ok(existsSync(join(vaultDir, CONFLICT)));
    });

    it("merges, deletes the copy only after writing, logs and backs up", async () => {
        const merged = "# Plan\n- buy milk\n- call Anna\n- book train\n";
        const text = await callTool("resolve_conflict", {
            conflict_path: CONFLICT, action: "merge", merged_content: merged,
            expected_original_hash: originalHash, expected_conflict_hash: conflictHash,
            reason: "The copy only added one line.",
        });
        assert.match(text, /^Resolved \(merge\): notes\/plan\.md; conflict copy deleted/);
        assert.equal(await readFile(join(vaultDir, "notes/plan.md"), "utf-8"), merged);
        assert.equal(existsSync(join(vaultDir, CONFLICT)), false);
        const log = await readFile(join(vaultDir, "_system/Sync conflict log.md"), "utf-8");
        assert.match(log, /\*\*escalate\*\*/);
        assert.match(log, /\*\*merge\*\* \[\[notes\/plan\.md\]\] vs `notes\/plan\.sync-conflict-20261003-101010-ABCDEFG\.md` \(device ABCDEFG\): The copy only added one line\./);
        const day = new Date().toISOString().slice(0, 10);
        const backups = await readdir(join(vaultDir, ".mcp-backups", day, "notes"));
        assert.ok(backups.some((f) => f.startsWith("plan.md.")), "original backed up");
        assert.ok(backups.some((f) => f.startsWith("plan.sync-conflict-")), "conflict copy backed up");
        assert.match(await callTool("list_conflicts", {}), /^No sync conflicts found\. 1 conflict\(s\) involving private notes/);
    });
});

describe("E2E: conflict tools on binary files", () => {
    it("refuses to rewrite a non-text original", async () => {
        const copy = "img.sync-conflict-20261003-121212-ABCDEFG.png";
        await writeFile(join(vaultDir, "img.png"), "PNG-A");
        await writeFile(join(vaultDir, copy), "PNG-B");
        const list = await callTool("list_conflicts", {});
        const block = list.split("\n- ").find((b) => b.startsWith(copy))!;
        const oh = block.match(/original img\.png \(\d+ chars, hash ([0-9a-f]{16})\)/)![1];
        const ch = block.match(/conflict copy: \d+ chars, hash ([0-9a-f]{16})/)![1];
        const text = await callTool("resolve_conflict", { conflict_path: copy, action: "keep_conflict", expected_original_hash: oh, expected_conflict_hash: ch, reason: "test" });
        assert.match(text, /^Refused: img\.png is not a text note/);
        assert.equal(await readFile(join(vaultDir, "img.png"), "utf-8"), "PNG-A");
    });
});
