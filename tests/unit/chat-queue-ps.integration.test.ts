import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// ps（プロセス一覧）の取得が失敗する場面を作るため、readProcessTable だけを差し替える
const psState = { fail: false };
vi.mock("../../server/process-tree.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/process-tree.ts")>();
  return { ...original, readProcessTable: async () => (psState.fail ? Promise.reject(new Error("ps failed")) : original.readProcessTable()) };
});

const CLAUDE_ID = "ffffffff-0000-4000-8000-000000000001";
let h: Harness;
let rowsFile: string;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-chatq-ps-"));
  rowsFile = path.join(dir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(dir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, pasteSubmitDelayMs: 100 });
});
afterAll(async () => {
  await h.close();
});

describe("MEDIUM-2: ps が失敗したときは送らない", () => {
  it("手すきの行があっても、プロセス一覧を取れない間は端末に何も書かない。取れるようになったら送る", async () => {
    const write = vi.spyOn(h.sessions, "write");
    const s = h.sessions.restore({ role: h.config.roles[0], name: "ps-fail", cwd: h.config.salesanchorRoot, branch: null, manualInitialName: true });
    h.sessions.setClaudeSessionId(s.id, CLAUDE_ID);
    writeFileSync(rowsFile, JSON.stringify([{ pid: s.term.pid, status: "idle", name: "n", sessionId: CLAUDE_ID, cwd: "/", startedAt: 1 }]));
    psState.fail = true;
    await h.hub.pollAgents();
    const res = await fetch(`${h.base}/api/sessions/${s.id}/chat/queue`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "ps 失敗中" }) });
    expect(res.status).toBe(201);
    await h.hub.pollAgents();
    await new Promise((r) => setTimeout(r, 500));
    expect(write.mock.calls.filter(([x]) => x.id === s.id)).toEqual([]);
    psState.fail = false;
    await h.hub.pollAgents();
    expect(write.mock.calls.filter(([x]) => x.id === s.id).map(([, d]) => d)).toEqual(["\u001b[200~ps 失敗中\u001b[201~", "\r"]);
    write.mockRestore();
    await h.sessions.close(s.id);
  });
});
