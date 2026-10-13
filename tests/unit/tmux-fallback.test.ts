import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SessionManager } from "../../server/sessions.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";
import { waitFor } from "./helpers/tmux-env.ts";

/** R8: tmux を使えない時は direct で開き、黙って続けずに tmuxMissing の案内を出す（本物の tmux・ソケットには触れない） */
describe("fallback to direct always shows the notice (R8)", () => {
  const hosts: Harness[] = [];
  const dirs: string[] = [];
  afterAll(async () => {
    for (const h of hosts) await h.close().catch(() => undefined);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("tmux.conf missing: warns, notice tmuxMissing, and a conversation still opens (direct)", async () => {
    const h = await startHarness({ terminalHost: "tmux", tmuxSocket: "ac-test-fallback-conf" });
    hosts.push(h);
    const warns: string[] = [];
    const sm = new SessionManager(h.config, { tmuxConf: "/nonexistent/agent-console.tmux.conf", logger: { info: () => undefined, warn: (m) => warns.push(m) } });
    expect(sm.terminalNotices()).toEqual([{ reason: "tmuxMissing" }]);
    expect(warns.some((w) => w.includes("tmux conf not found"))).toBe(true);
    const s = await sm.create({ name: "direct-conf", roleId: "echo" });
    expect(await waitFor(() => sm.get(s.id)!.ring.snapshot().includes("READY"))).toBe(true);
    await sm.close(s.id);
  });

  it("new-session fails: warns, falls back to direct, and the tmuxMissing notice is shown", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ac-fake-tmux-fail-"));
    dirs.push(dir);
    const fake = path.join(dir, "tmux");
    // -V と list-sessions 等は成功、new-session だけ失敗する偽の tmux
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do if [ "$a" = "new-session" ]; then echo "create failed" >&2; exit 1; fi; done\nexit 1\n');
    chmodSync(fake, 0o755);
    const h = await startHarness({ terminalHost: "tmux", tmuxSocket: "ac-test-fallback-new", tmuxPath: fake });
    hosts.push(h);
    expect(h.sessions.terminalNotices()).toEqual([]);
    const s = await h.sessions.create({ name: "direct-new", roleId: "echo" });
    expect(await waitFor(() => h.sessions.get(s.id)!.ring.snapshot().includes("READY"))).toBe(true);
    expect(h.sessions.terminalNotices()).toEqual([{ reason: "tmuxMissing" }]);
    await h.sessions.close(s.id);
  });
});
