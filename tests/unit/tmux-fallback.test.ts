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

  it("S2: tmux older than 3.8 warns once that terminal modes are not restored on reattach; 3.8 does not", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ac-fake-tmux-ver-"));
    dirs.push(dir);
    const make = (ver: string): string => {
      const f = path.join(dir, `tmux-${ver}`);
      writeFileSync(f, `#!/bin/sh\nif [ "$1" = "-V" ]; then echo "tmux ${ver}"; exit 0; fi\nexit 1\n`);
      chmodSync(f, 0o755);
      return f;
    };
    const h = await startHarness({ terminalHost: "tmux", tmuxSocket: "ac-test-fallback-ver" });
    hosts.push(h);
    const run = (ver: string): string[] => {
      const warns: string[] = [];
      new SessionManager({ ...h.config, tmuxPath: make(ver) }, { logger: { info: () => undefined, warn: (m) => warns.push(m) } });
      return warns;
    };
    const old = run("3.7c");
    expect(old.filter((w) => w.includes("3.8 未満"))).toEqual(["tmux 3.7c は 3.8 未満のため、つなぎ直しで端末のモード（貼り付けモード等）が戻らない"]);
    expect(run("3.8").filter((w) => w.includes("3.8 未満"))).toEqual([]);
  });
});
