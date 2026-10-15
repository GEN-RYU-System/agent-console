import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probeSession } from "../../server/terminal-host/tmux-runner.ts";

// 偽の tmux（シェルスクリプト）で has-session / display の応答を差し替え、probeSession の振り分けを確かめる
const dir = mkdtempSync(path.join(tmpdir(), "probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeTmux(name: string, hasRc: number, hasErr: string, displayOut: string): { ctx: { tmux: string; socket: string; conf: string }; log: string } {
  const bin = path.join(dir, name);
  const log = path.join(dir, `${name}.log`);
  const q = (v: string): string => v.replace(/'/g, "'\\''");
  writeFileSync(bin, `#!/bin/sh
for a in "$@"; do case "$a" in has-session|display) cmd="$a";; esac; done
echo "$cmd" >> '${log}'
if [ "$cmd" = has-session ]; then
  printf '%s' '${q(hasErr)}' >&2
  exit ${hasRc}
fi
printf '%s\\n' '${q(displayOut)}'
exit 0
`);
  chmodSync(bin, 0o755);
  return { ctx: { tmux: bin, socket: "s", conf: "/dev/null" }, log };
}
const calls = (log: string): string[] => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe("probeSession（再起動後の gone 判定）", () => {
  it("tmux サーバーが無い（error connecting ... No such file or directory）-> gone", () => {
    const f = fakeTmux("noserver", 1, "error connecting to /private/tmp/tmux-501/s (No such file or directory)", "");
    expect(probeSession(f.ctx, "ac-x", {})).toEqual({ state: "gone" });
  });
  it("has-session が can't find session -> display を呼ばずに gone", () => {
    const f = fakeTmux("nosession", 1, "can't find session: ac-x", "");
    expect(probeSession(f.ctx, "ac-x", {})).toEqual({ state: "gone" });
    expect(calls(f.log)).toEqual(["has-session"]);
  });
  it("Permission denied -> unreachable", () => {
    const f = fakeTmux("denied", 1, "error connecting to /private/tmp/tmux-501/s (Permission denied)", "");
    expect(probeSession(f.ctx, "ac-x", {})).toEqual({ state: "unreachable" });
  });
  it("生きているセッション -> alive と pid", () => {
    const f = fakeTmux("alive", 0, "", "4242");
    expect(probeSession(f.ctx, "ac-x", {})).toEqual({ state: "alive", pid: 4242 });
    expect(calls(f.log)).toEqual(["has-session", "display"]);
  });
});
