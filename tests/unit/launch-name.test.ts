import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hub } from "../../server/hub.ts";
import { launchAndSend } from "../../server/launch.ts";

/** K6: 新しく開いたセッションへの書き込み順は「/rename <名前>\r → 指示の貼り付け → Enter」。restore には manualInitialName: true */
const TIMING = { pollMs: 5, timeoutMs: 80, namePollMs: 5, nameTimeoutMs: 20 };

const setup = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-launch-name-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const cfg = { salesanchorRoot: root, roles: [{ id: "echo", needsWorktree: false, command: ["echo"] }], pasteSubmitDelayMs: 0 };
  const created: { id: string; exited: boolean }[] = [];
  const writes: string[] = [];
  const sessions = {
    get: vi.fn((id: string) => created.find((s) => s.id === id)),
    write: vi.fn((_s: unknown, data: string) => { writes.push(data); }),
    isClosing: vi.fn(() => false),
    hasCapacity: vi.fn(() => true),
    restore: vi.fn(() => { const s = { id: `s${created.length + 1}`, exited: false }; created.push(s); return s; }),
  };
  const names = new Map<string, string>();
  const hub = {
    checkInput: vi.fn(async () => ({ ok: true, hasClaude: true })),
    sessions,
    config: cfg,
    writing: new Set<string>(),
    displayNames: () => names,
    tryBeginWrite: (id: string) => Hub.prototype.tryBeginWrite.call(hub, id),
    endWrite: (id: string) => Hub.prototype.endWrite.call(hub, id),
    // 本物の sendName / submitText を、偽の sessions で動かす
    sendName: (id: string, name: string) => {
      const ok = Hub.prototype.sendName.call(hub, id, name);
      if (ok) names.set(id, name);
      return ok;
    },
    submitText: (id: string, text: string) => Hub.prototype.submitText.call(hub, id, text),
  };
  return { root, cfg, sessions, hub, writes };
};

describe("K6 launchAndSend writes /rename first", () => {
  it("writes /rename, then the bracketed paste, then Enter; restore gets manualInitialName", async () => {
    const t = setup();
    const result = await launchAndSend({ config: t.cfg as never, sessions: t.sessions as never, hub: t.hub as never, timing: TIMING }, { roleId: "echo", cwd: t.root, name: "daily", slotKey: "2026-10-12T09:00+09:00", promptText: "go", stillWanted: () => true });
    expect(result.outcome).toBe("sent");
    expect(t.writes).toEqual(["/rename daily 10/12 09:00\r", "\u001b[200~go\u001b[201~", "\r"]);
    expect((t.sessions.restore.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ manualInitialName: true, name: "daily 10/12 09:00" });
  });

  it("keeps going when sendName cannot take the write mark (the prompt is still sent)", async () => {
    const t = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const orig = t.hub.sendName;
    t.hub.sendName = () => false;
    const result = await launchAndSend({ config: t.cfg as never, sessions: t.sessions as never, hub: t.hub as never, timing: TIMING }, { roleId: "echo", cwd: t.root, name: "daily", slotKey: "2026-10-12T09:00+09:00", promptText: "go", stillWanted: () => true });
    expect(result.outcome).toBe("sent");
    expect(t.writes).toEqual(["\u001b[200~go\u001b[201~", "\r"]);
    expect(warn).toHaveBeenCalled();
    t.hub.sendName = orig;
    warn.mockRestore();
  });
});
