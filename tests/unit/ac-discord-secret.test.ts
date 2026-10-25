import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeAcEnv, type AcEnv } from "./helpers/ac-env.ts";

const envs: AcEnv[] = [];
afterEach(() => { for (const e of envs.splice(0)) e.cleanup(); });

async function fresh(): Promise<AcEnv> {
  const e = await makeAcEnv();
  envs.push(e);
  return e;
}
// 値は作り物。入力画面の代わりのスタブ
function fakeOsascript(e: AcEnv, body: string): string {
  const f = path.join(e.base, "bin", "osascript-fake");
  writeFileSync(f, `#!/bin/bash\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
const FAKE = "fake.TOKEN-value_1";

describe("ac-discord-secret.sh", () => {
  it("値は標準入力でだけ security に渡り、引数・出力・ログには出ない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_OSASCRIPT: fakeOsascript(e, `echo ${FAKE}`) });
    expect(r.status, r.stderr).toBe(0);
    expect(e.secret()).toBe(FAKE);
    expect(e.log()).not.toContain(FAKE);
    expect(r.stdout + r.stderr).not.toContain(FAKE);
    expect(e.log()).toContain("security -i");
    expect(e.log()).toContain("find-generic-password -s agent-console -a discord-bot");
  });
  it("取り消し（入力画面が失敗）なら保存せず、取り消した旨を出す", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_OSASCRIPT: fakeOsascript(e, "exit 1") });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("取り消しました");
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it("空白を含む値は保存しない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-report-webhook"], { AC_OSASCRIPT: fakeOsascript(e, "echo 'a b'") });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it.each([
    ["二重引用符", `printf '%s\\n' 'a"b'`],
    ["単一引用符", `printf '%s\\n' "a'b"`],
    ["バックスラッシュ", `printf '%s\\n' 'a\\b'`],
  ])("%s を含む値は保存しない", async (_name, body) => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_OSASCRIPT: fakeOsascript(e, body) });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it("知らない項目は保存しない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["other"], { AC_OSASCRIPT: fakeOsascript(e, `echo ${FAKE}`) });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
  });
  it("保存の確認に失敗したら 0 以外で終わる", async () => {
    const e = await fresh();
    // find が常に失敗する security に差し替える（保存はするが確認が通らない）
    const sec = path.join(e.base, "bin", "security-nofind");
    writeFileSync(sec, `#!/bin/bash\ncase "$1" in -i) cat >/dev/null ;; *) exit 44 ;; esac\nexit 0\n`);
    chmodSync(sec, 0o755);
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_OSASCRIPT: fakeOsascript(e, `echo ${FAKE}`), AC_SECURITY: sec });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("確認できませんでした");
  });
});
