import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

// git を何度も起動する試験。他のプロセスで機械が混んでいても 5 秒の既定に収まらないことがあるため長くする
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let h: Harness;
let root: string;
let rowsFile: string;
let sessionId = "";

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
const files = (json: Record<string, unknown>): Array<Record<string, unknown>> => json.files as Array<Record<string, unknown>>;
const byPath = (json: Record<string, unknown>, p: string): Record<string, unknown> | undefined => files(json).find((f) => f.path === p);
const diffOf = (id: string) => api("GET", `/api/sessions/${id}/diff`);
const fileDiffOf = (id: string, p: string) => api("GET", `/api/sessions/${id}/diff/file?path=${encodeURIComponent(p)}`);
const comments = (id: string) => api("GET", `/api/sessions/${id}/diff-comments`);
const items = (json: Record<string, unknown>): Array<Record<string, unknown>> => json.items as Array<Record<string, unknown>>;

async function newSession(roleId: string, name: string): Promise<string> {
  const res = await api("POST", "/api/sessions", { name, roleId });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

beforeAll(async () => {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "ac-diff-stub-"));
  rowsFile = path.join(stubDir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(stubDir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, maxSessions: 40, diffMaxFileBytes: 2000, diffSendMaxBytes: 4000 });
  root = realpathSync(path.join(h.dir, "root"));
  // 基準（origin/main）になるコミット
  writeFileSync(path.join(root, "a.txt"), "a1\na2\na3\n");
  writeFileSync(path.join(root, "b.txt"), "b1\nb2\n");
  writeFileSync(path.join(root, "old-name.txt"), "rename me\nline2\nline3\nline4\n");
  writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]));
  writeFileSync(path.join(root, "big.txt"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  // コミット済みの変更
  writeFileSync(path.join(root, "b.txt"), "b1\nb2\nb3\n");
  git(root, "commit", "-q", "-am", "committed change");
  // 未コミットの変更
  writeFileSync(path.join(root, "a.txt"), "a1\nA2\na3\n");
  // 名前の変更（ステージ済み）
  git(root, "mv", "old-name.txt", "new-name.txt");
  // バイナリの変更・大きすぎる変更
  writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 9, 9, 9, 0]));
  writeFileSync(path.join(root, "big.txt"), `${"y".repeat(100)}\n`.repeat(100));
  // 未追加
  writeFileSync(path.join(root, "untracked.txt"), "u\n");
  writeFileSync(path.join(root, "with space.txt"), "s\n");
  sessionId = await newSession("echo", "diff-main");
});
afterAll(async () => {
  await h.close();
});

describe("list of changed files (K1, K13)", () => {
  it("lists committed, uncommitted and untracked changes against origin/main", async () => {
    const res = await diffOf(sessionId);
    expect(res.status).toBe(200);
    expect(res.json.baseRef).toBe("origin/main");
    expect(byPath(res.json, "b.txt")).toEqual({ path: "b.txt", added: 1, removed: 0, binary: false, untracked: false });
    expect(byPath(res.json, "a.txt")).toEqual({ path: "a.txt", added: 1, removed: 1, binary: false, untracked: false });
    expect(byPath(res.json, "untracked.txt")).toEqual({ path: "untracked.txt", added: 0, removed: 0, binary: false, untracked: true });
    expect(byPath(res.json, "with space.txt")?.untracked).toBe(true);
  });

  it("counts a renamed file as one deletion and one addition, so the number of rows and the names stay consistent (K13)", async () => {
    const res = await diffOf(sessionId);
    expect(byPath(res.json, "old-name.txt")).toEqual({ path: "old-name.txt", added: 0, removed: 4, binary: false, untracked: false });
    expect(byPath(res.json, "new-name.txt")).toEqual({ path: "new-name.txt", added: 4, removed: 0, binary: false, untracked: false });
    const names = files(res.json).map((f) => f.path as string);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n !== "" && !n.includes("\t"))).toBe(true);
  });
});

describe("one file diff (K2, K8, K9)", () => {
  it("returns numbered add / del / ctx lines", async () => {
    const res = await fileDiffOf(sessionId, "a.txt");
    expect(res.status).toBe(200);
    const lines = res.json.lines as Array<Record<string, unknown>>;
    expect(lines.find((l) => l.kind === "add")).toEqual({ kind: "add", newLine: 2, text: "A2" });
    expect(lines.find((l) => l.kind === "del")).toEqual({ kind: "del", oldLine: 2, text: "a2" });
  });

  it("returns tooLarge instead of the body when the diff exceeds the configured byte limit", async () => {
    const res = await fileDiffOf(sessionId, "big.txt");
    expect(res.status).toBe(200);
    expect(res.json.tooLarge).toBe(true);
    expect(res.json.lines).toBeUndefined();
  });

  it("marks binary files in the list and returns no lines for them", async () => {
    expect(byPath((await diffOf(sessionId)).json, "bin.dat")?.binary).toBe(true);
    const res = await fileDiffOf(sessionId, "bin.dat");
    expect(res.status).toBe(200);
    expect(res.json.binary).toBe(true);
  });

  it("returns no lines for an untracked file (name only)", async () => {
    const res = await fileDiffOf(sessionId, "untracked.txt");
    expect(res.status).toBe(200);
    expect(res.json.untracked).toBe(true);
  });

  it("rejects names that are not in the list the server just built (400), including ../ and absolute paths", async () => {
    for (const bad of ["../etc/passwd", "nope.txt", "/etc/passwd", "a.txt/../b.txt", "", "-p"]) {
      expect((await fileDiffOf(sessionId, bad)).status).toBe(400);
    }
  });
});

describe("comments (K3, K4, K9)", () => {
  const add = (id: string, over: Record<string, unknown> = {}) =>
    api("POST", `/api/sessions/${id}/diff-comments`, { path: "a.txt", side: "new", line: 2, lineText: "A2", body: "ここを直して", ...over });

  it("adds, edits and deletes a comment, and keeps it in the data file with mode 600", async () => {
    const created = await add(sessionId);
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(items((await comments(sessionId)).json)).toEqual([expect.objectContaining({ id, path: "a.txt", side: "new", line: 2, lineText: "A2", body: "ここを直して" })]);
    const edited = await api("PUT", `/api/sessions/${sessionId}/diff-comments/${id}`, { path: "a.txt", side: "new", line: 2, lineText: "A2", body: "直しました？" });
    expect(edited.status).toBe(200);
    expect(items((await comments(sessionId)).json)[0].body).toBe("直しました？");
    const file = path.join(h.config.dataDir, "diff-comments.json");
    expect(readFileSync(file, "utf8")).toContain("直しました？");
    expect(execFileSync("stat", ["-f", "%Lp", file], { encoding: "utf8" }).trim()).toBe("600");
    expect((await api("DELETE", `/api/sessions/${sessionId}/diff-comments/${id}`)).status).toBe(200);
    expect(items((await comments(sessionId)).json)).toEqual([]);
    expect((await api("DELETE", `/api/sessions/${sessionId}/diff-comments/${id}`)).status).toBe(404);
  });

  it("rejects a path that is not in the current list, for both adding and editing (400)", async () => {
    for (const bad of ["../x", "nope.txt", "/etc/passwd", ""]) {
      expect((await add(sessionId, { path: bad })).status).toBe(400);
    }
    const ok = await add(sessionId);
    const res = await api("PUT", `/api/sessions/${sessionId}/diff-comments/${ok.json.id as string}`, { path: "../x", side: "new", line: 1, body: "x" });
    expect(res.status).toBe(400);
    await api("DELETE", `/api/sessions/${sessionId}/diff-comments/${ok.json.id as string}`);
  });

  it("validates side, line, body (400)", async () => {
    expect((await add(sessionId, { side: "middle" })).status).toBe(400);
    expect((await add(sessionId, { line: 0 })).status).toBe(400);
    expect((await add(sessionId, { line: 1.5 })).status).toBe(400);
    expect((await add(sessionId, { line: "2" })).status).toBe(400);
    expect((await add(sessionId, { side: "file" })).status).toBe(400); // file には line を付けない
    expect((await add(sessionId, { body: "" })).status).toBe(400);
    expect((await add(sessionId, { body: "x".repeat(2001) })).status).toBe(400);
    expect((await add(sessionId, { body: "a\u001bb" })).status).toBe(400);
    const fileLevel = await add(sessionId, { side: "file", line: undefined, lineText: undefined, body: "全体に" });
    expect(fileLevel.status).toBe(201);
    await api("DELETE", `/api/sessions/${sessionId}/diff-comments/${fileLevel.json.id as string}`);
  });

  it("drops the comments of a working directory that no longer exists, and survives a store restart (K4)", async () => {
    // 本店のコメントは別のストア（サーバー再起動の再現）から読める
    const kept = await add(sessionId, { body: "残る" });
    const { DiffCommentStore } = await import("../../server/diff-comments.ts");
    const second = new DiffCommentStore(h.config.dataDir);
    const known = [{ dir: root, branch: git(root, "rev-parse", "--abbrev-ref", "HEAD").trim() }];
    expect((await second.list({ dir: root, known })).map((c) => c.body)).toContain("残る");
    // worktree を作ってコメントし、worktree を消すと、そのコメントは消える
    const wt = path.join(h.dir, "wt-gone");
    git(root, "worktree", "add", "-q", "-b", "release/gone", wt);
    const wtReal = realpathSync(wt);
    writeFileSync(path.join(wtReal, "w.txt"), "w\n");
    const wtSession = h.sessions.restore({ role: h.config.roles[0], name: "wt", cwd: wtReal, branch: "release/gone" });
    const wtComment = await api("POST", `/api/sessions/${wtSession.id}/diff-comments`, { path: "w.txt", side: "file", body: "消える" });
    expect(wtComment.status).toBe(201);
    const file = path.join(h.config.dataDir, "diff-comments.json");
    expect(readFileSync(file, "utf8")).toContain("消える");
    await h.sessions.close(wtSession.id);
    git(root, "worktree", "remove", "--force", wt);
    expect(items((await comments(sessionId)).json).map((c) => c.body)).toEqual(["残る"]);
    expect(readFileSync(file, "utf8")).not.toContain("消える");
    await api("DELETE", `/api/sessions/${sessionId}/diff-comments/${kept.json.id as string}`);
  });

  it("drops the comments when a different branch is checked out in the same place (K4, branch check)", async () => {
    const wt = path.join(h.dir, "wt-same");
    git(root, "worktree", "add", "-q", "-b", "release/first", wt);
    const wtReal = realpathSync(wt);
    writeFileSync(path.join(wtReal, "w.txt"), "w\n");
    const s1 = h.sessions.restore({ role: h.config.roles[0], name: "wt1", cwd: wtReal, branch: "release/first" });
    await api("POST", `/api/sessions/${s1.id}/diff-comments`, { path: "w.txt", side: "file", body: "古いブランチのコメント" });
    await h.sessions.close(s1.id);
    git(root, "worktree", "remove", "--force", wt);
    git(root, "worktree", "add", "-q", "-b", "release/second", wt);
    writeFileSync(path.join(wtReal, "w.txt"), "w\n");
    const s2 = h.sessions.restore({ role: h.config.roles[0], name: "wt2", cwd: wtReal, branch: "release/second" });
    expect(items((await comments(s2.id)).json)).toEqual([]);
    await h.sessions.close(s2.id);
    git(root, "worktree", "remove", "--force", wt);
  });

  it("keeps a corrupt data file untouched and reports it instead of overwriting (K4)", async () => {
    const file = path.join(h.config.dataDir, "diff-comments.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, "{ broken");
    const read = await comments(sessionId);
    expect(read.status).toBe(500);
    expect((await add(sessionId)).status).toBe(500);
    expect(readFileSync(file, "utf8")).toBe("{ broken");
    writeFileSync(file, before);
  });
});

describe("not a place we may run git in (K7)", () => {
  it("returns 409 and runs no git when the working directory is neither the main checkout nor a worktree", async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-outside-")));
    execFileSync("git", ["init", "-q"], { cwd: outside });
    const s = h.sessions.restore({ role: h.config.roles[0], name: "outside", cwd: outside, branch: null });
    for (const [m, p, body] of [
      ["GET", `/api/sessions/${s.id}/diff`, undefined],
      ["GET", `/api/sessions/${s.id}/diff/file?path=a.txt`, undefined],
      ["GET", `/api/sessions/${s.id}/diff-comments`, undefined],
      ["POST", `/api/sessions/${s.id}/diff-comments`, { path: "a.txt", side: "file", body: "x" }],
      ["POST", `/api/sessions/${s.id}/diff-comments/send-check`, {}],
    ] as const) {
      const res = await api(m, p, body);
      expect(res.status, `${m} ${p}`).toBe(409);
    }
    await h.sessions.close(s.id);
    rmSync(outside, { recursive: true, force: true });
  });

  it("returns 404 for an unknown session", async () => {
    expect((await diffOf("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("no base ref", () => {
  it("answers noBase (not a 500) when origin/main does not exist", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-nobase-")));
    mkdirSync(path.join(dir, "x"));
    // 本店とは別の harness を立てる（origin/main の無い本店）
    const h2 = await startHarness({ maxSessions: 4 });
    try {
      const root2 = realpathSync(path.join(h2.dir, "root"));
      git(root2, "commit", "-q", "--allow-empty", "-m", "seed");
      const created = await fetch(`${h2.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ name: "nb", roleId: "echo" }) });
      const id = ((await created.json()) as { id: string }).id;
      const res = await fetch(`${h2.base}/api/sessions/${id}/diff`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ error: "noBase", baseRef: "origin/main" });
    } finally {
      await h2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("send-check and mark-sent (K5, K6)", () => {
  let commentId = "";
  beforeAll(async () => {
    const created = await api("POST", `/api/sessions/${sessionId}/diff-comments`, { path: "a.txt", side: "new", line: 2, lineText: "A2", body: "送る分" });
    commentId = created.json.id as string;
  });

  it("refuses with 409 and the reason while Claude is working or waiting (K6)", async () => {
    const pid = h.sessions.get(sessionId)?.term.pid as number;
    for (const status of ["busy", "waiting"]) {
      writeFileSync(rowsFile, JSON.stringify([{ pid, status, name: "n", sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/", startedAt: 1 }]));
      const res = await api("POST", `/api/sessions/${sessionId}/diff-comments/send-check`, {});
      expect(res.status, status).toBe(409);
      expect(String(res.json.error)).toContain(status);
    }
  });

  it("returns the text, the ids and the submit delay when Claude is idle, and marks them sent only on mark-sent (K5)", async () => {
    const pid = h.sessions.get(sessionId)?.term.pid as number;
    writeFileSync(rowsFile, JSON.stringify([{ pid, status: "idle", name: "n", sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/", startedAt: 1 }]));
    const res = await api("POST", `/api/sessions/${sessionId}/diff-comments/send-check`, {});
    expect(res.status).toBe(200);
    expect(res.json.ids).toEqual([commentId]);
    expect(res.json.submitDelayMs).toBe(h.config.pasteSubmitDelayMs);
    expect(String(res.json.text)).toContain("File: a.txt\nLine: 2（新しい側）\n該当行: A2\nComment: 送る分");
    // send-check だけでは送信済みにならない
    expect(items((await comments(sessionId)).json)[0].sentAt).toBeUndefined();
    const marked = await api("POST", `/api/sessions/${sessionId}/diff-comments/mark-sent`, { ids: [commentId, "unknown-id"] });
    expect(marked.status).toBe(200);
    expect(typeof items((await comments(sessionId)).json)[0].sentAt).toBe("number");
    // 送信済みしか無いときは、もう送る物が無い
    expect((await api("POST", `/api/sessions/${sessionId}/diff-comments/send-check`, {})).status).toBe(400);
  });

  it("clears sentAt when a comment is edited (back to unsent)", async () => {
    const edited = await api("PUT", `/api/sessions/${sessionId}/diff-comments/${commentId}`, { path: "a.txt", side: "new", line: 2, lineText: "A2", body: "直した" });
    expect(edited.status).toBe(200);
    expect(items((await comments(sessionId)).json)[0].sentAt).toBeUndefined();
  });

  it("refuses to send when the text would exceed the byte limit (400)", async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await api("POST", `/api/sessions/${sessionId}/diff-comments`, { path: "a.txt", side: "file", body: "あ".repeat(500) });
      expect(r.status).toBe(201);
    }
    const res = await api("POST", `/api/sessions/${sessionId}/diff-comments/send-check`, {});
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/too long/);
  });

  it("rejects a mark-sent body without an ids array (400)", async () => {
    expect((await api("POST", `/api/sessions/${sessionId}/diff-comments/mark-sent`, { ids: "x" })).status).toBe(400);
  });
});
