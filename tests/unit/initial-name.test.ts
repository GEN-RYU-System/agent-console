import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { INITIAL_NAME_MAX_MS } from "../../server/hub.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let h: Harness;
let rowsFile: string;
let write: MockInstance<typeof h.sessions.write>;
const made: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-initname-"));
  rowsFile = path.join(dir, "rows.json");
  writeFileSync(rowsFile, "[]");
  const stub = path.join(dir, "claude-stub.sh");
  writeFileSync(stub, `#!/bin/bash\ncase "$1" in agents) cat "${rowsFile}";; --version) echo stub;; esac\n`);
  chmodSync(stub, 0o755);
  h = await startHarness({ claudeBin: stub, pasteSubmitDelayMs: 0 });
  write = vi.spyOn(h.sessions, "write");
});
afterAll(async () => {
  await h.close();
});
afterEach(async () => {
  write.mockClear();
  vi.useRealTimers();
  for (const id of made.splice(0)) if (h.sessions.get(id)) await h.sessions.close(id);
});

const setRows = (rows: unknown[]): void => writeFileSync(rowsFile, JSON.stringify(rows));
let counter = 0;
async function newSession(name: string): Promise<{ id: string; pid: number; claudeId: string }> {
  counter += 1;
  const claudeId = `dddddddd-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const s = await h.sessions.create({ roleId: h.config.roles[0].id, name });
  made.push(s.id);
  return { id: s.id, pid: s.term.pid, claudeId };
}
const row = (pid: number, status: string, claudeId: string, name: string, extra: Record<string, unknown> = {}) => ({ pid, status, name, sessionId: claudeId, cwd: "/", startedAt: 1, ...extra });
const renames = (id: string): string[] => write.mock.calls.filter(([s, d]) => s.id === id && d.startsWith("/rename")).map(([, d]) => d);

describe("K4 flushInitialNames", () => {
  it("Claude が見つからない・ok でない間は書かず checkInput も呼ばない。ok になったら 1 回だけ書く", async () => {
    const { id, pid, claudeId } = await newSession("テスト5");
    const check = vi.spyOn(h.hub, "checkInput");
    setRows([]);
    await h.hub.pollAgents();
    setRows([row(pid, "busy", claudeId, "work-06")]);
    await h.hub.pollAgents();
    setRows([row(pid, "waiting", claudeId, "work-06", { waitingFor: "permission prompt" })]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    setRows([row(pid, "idle", claudeId, "work-06")]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual(["/rename テスト5\r"]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual(["/rename テスト5\r"]);
    expect(h.sessions.get(id)?.initialName).toBeUndefined();
    check.mockRestore();
  });

  it("Claude 側の名前が同じなら書かず、checkInput も呼ばず、印を消す", async () => {
    const { id, pid, claudeId } = await newSession("同じ名前");
    const check = vi.spyOn(h.hub, "checkInput");
    setRows([row(pid, "idle", claudeId, "同じ名前")]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect(h.sessions.get(id)?.initialName).toBeUndefined();
    check.mockRestore();
  });

  it("名前の変更の予約が有れば、その名前が 1 回だけ書かれ、initialName は書かれない", async () => {
    const { id, pid, claudeId } = await newSession("初回");
    setRows([row(pid, "busy", claudeId, "work-06")]);
    await h.hub.pollAgents();
    expect(await h.hub.requestRename(id, "予約の名前")).toBe("queued");
    setRows([row(pid, "idle", claudeId, "work-06")]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual(["/rename 予約の名前\r"]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual(["/rename 予約の名前\r"]);
    expect(h.sessions.get(id)?.initialName).toBeUndefined();
  });

  it("Claude 起動前に PO が改名したら、initialName はその名前に差し替わり、起動後に送られる名前は PO の名前", async () => {
    const { id, pid, claudeId } = await newSession("初回の名前");
    setRows([]);
    await h.hub.pollAgents();
    expect(await h.hub.requestRename(id, "POの名前")).toBe("app");
    expect(h.sessions.get(id)?.name).toBe("POの名前");
    expect(h.sessions.get(id)?.initialName).toBe("POの名前");
    expect(renames(id)).toEqual([]);
    setRows([row(pid, "idle", claudeId, "work-06")]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual(["/rename POの名前\r"]);
    expect(h.sessions.get(id)?.initialName).toBeUndefined();
  });

  it("10 分を過ぎたら送らずに消す", async () => {
    const { id, pid, claudeId } = await newSession("古い");
    const session = h.sessions.get(id);
    if (!session) throw new Error("no session");
    session.createdAt = Date.now() - INITIAL_NAME_MAX_MS - 1000;
    setRows([row(pid, "idle", claudeId, "work-06")]);
    await h.hub.pollAgents();
    expect(renames(id)).toEqual([]);
    expect(session.initialName).toBeUndefined();
  });
});

describe("K5 restore が initialName を入れる条件", () => {
  const role = () => h.config.roles[0];
  const base = () => ({ role: role(), name: "復元", cwd: h.config.salesanchorRoot, branch: null });
  it("通常の restore は入れる。claudeSessionId で再開する起動・manualInitialName は入れない", () => {
    const a = h.sessions.restore(base());
    const resumable = { ...role(), restoreCommand: ["/bin/sh", "-c", "cat"] };
    const b = h.sessions.restore({ ...base(), role: resumable, claudeSessionId: "cccccccc-0000-4000-8000-000000000001" });
    const c = h.sessions.restore({ ...base(), manualInitialName: true });
    made.push(a.id, b.id, c.id);
    expect(a.initialName).toBe("復元");
    expect(b.initialName).toBeUndefined();
    expect(c.initialName).toBeUndefined();
  });
  it("create は入れる", async () => {
    const a = await h.sessions.create({ roleId: role().id, name: "新規" });
    made.push(a.id);
    expect(a.initialName).toBe("新規");
  });
});
