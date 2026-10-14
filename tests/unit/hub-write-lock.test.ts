import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// 書き込みの印（Hub.writing）。貼り付けと Enter の間に別の経路の /rename が割り込まないことを見る。
const DELAY_MS = 2500; // 待ちの間に requestRename の取り直し（ps・claude agents）が収まる長さ
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CLAUDE_ID = "ffffffff-0000-4000-8000-0000000000aa";

let h: Harness;
let rowsFile: string;
let write: MockInstance<typeof h.sessions.write>;
const made: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-writelock-"));
  rowsFile = path.join(dir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(dir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, pasteSubmitDelayMs: DELAY_MS });
  write = vi.spyOn(h.sessions, "write");
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  write.mockClear();
  for (const id of made.splice(0)) if (h.sessions.get(id)) await h.sessions.close(id);
});

let counter = 0;
function newIdleSession(): { id: string; pid: number } {
  counter += 1;
  const s = h.sessions.restore({ role: h.config.roles[0], name: `wl-${counter}`, cwd: h.config.salesanchorRoot, branch: null, manualInitialName: true });
  h.sessions.setClaudeSessionId(s.id, `${CLAUDE_ID.slice(0, -2)}${String(counter).padStart(2, "0")}`);
  made.push(s.id);
  const claudeId = h.sessions.get(s.id)?.claudeSessionId;
  writeFileSync(rowsFile, JSON.stringify([{ pid: s.term.pid, status: "idle", name: "n", sessionId: claudeId, cwd: "/", startedAt: 1 }]));
  return { id: s.id, pid: s.term.pid };
}
const written = (id: string): string[] => write.mock.calls.filter(([s]) => s.id === id).map(([, data]) => data);
const pasted = (text: string): string => `${PASTE_START}${text}${PASTE_END}`;
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("K1 送信の予約と /rename", () => {
  it("貼り付けと Enter の間に来た requestRename は書かれず予約になり、Enter の後の定期取得で 1 回書かれる", async () => {
    const { id } = newIdleSession();
    await h.hub.pollAgents();
    const res = await fetch(`${h.base}/api/sessions/${id}/chat/queue`, { method: "POST", headers, body: JSON.stringify({ text: "本文" }) });
    expect(res.status).toBe(201);
    const poll = h.hub.pollAgents();
    await until(() => written(id).includes(pasted("本文")));
    // ここは貼り付けと Enter の間
    expect(written(id)).toEqual([pasted("本文")]);
    expect(await h.hub.requestRename(id, "あとで")).toBe("queued");
    expect(written(id)).toEqual([pasted("本文")]);
    await poll;
    // 予約の登録でも送信が走るため、Enter が書かれるまで待つ
    await until(() => written(id).includes("\r"));
    expect(written(id)).toEqual([pasted("本文"), "\r"]);
    expect(h.hub.hasPendingWork(id)).toBe(true);
    await h.hub.pollAgents();
    expect(written(id)).toEqual([pasted("本文"), "\r", "/rename あとで\r"]);
    await h.hub.pollAgents();
    expect(written(id)).toEqual([pasted("本文"), "\r", "/rename あとで\r"]);
  });

  it("印が他に取られている間の flushChatQueueOnce は予約を queued のまま残し、印が外れた後の定期取得で送る", async () => {
    const { id } = newIdleSession();
    await h.hub.pollAgents();
    await fetch(`${h.base}/api/sessions/${id}/chat/queue`, { method: "POST", headers, body: JSON.stringify({ text: "待ち" }) });
    expect(h.hub.tryBeginWrite(id)).toBe(true);
    await h.hub.pollAgents();
    expect(written(id)).toEqual([]);
    expect(h.hub.chatQueueOf(id).map((i) => i.state)).toEqual(["queued"]);
    h.hub.endWrite(id);
    await h.hub.pollAgents();
    expect(written(id)).toEqual([pasted("待ち"), "\r"]);
  });
});

describe("K2 submitText の待ちの間", () => {
  it("requestRename・flushPendingRenames・flushInitialNames が走っても /rename を書かない。終わった後は印が外れる", async () => {
    const { id } = newIdleSession();
    await h.hub.pollAgents();
    const session = h.sessions.get(id);
    if (!session) throw new Error("no session");
    session.initialName = "初回の名前";
    const send = h.hub.submitText(id, "指示");
    await until(() => written(id).includes(pasted("指示")));
    expect(await h.hub.requestRename(id, "途中の改名")).toBe("queued");
    await h.hub.pollAgents();
    expect(written(id).some((d) => d.startsWith("/rename"))).toBe(false);
    expect(await send).toBe(true);
    expect(written(id)).toEqual([pasted("指示"), "\r"]);
    expect(h.hub.writing.has(id)).toBe(false);
    expect(h.hub.hasPendingWork(id)).toBe(true);
  });
});
