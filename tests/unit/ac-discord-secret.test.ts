import { spawnSync } from "node:child_process";
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
// 値は作り物。端末の代わりの入力ファイル（中身はその it の値と改行）
function inputFile(e: AcEnv, body: string): string {
  const f = path.join(e.base, "secret-input");
  writeFileSync(f, body);
  return f;
}
const FAKE = "fake.TOKEN-value_1";

describe("ac-discord-secret.sh", () => {
  it("値は標準入力でだけ security に渡り、引数・出力・ログには出ない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_SECRET_INPUT: inputFile(e, `${FAKE}\n`) });
    expect(r.status, r.stderr).toBe(0);
    expect(e.secret()).toBe(FAKE);
    expect(e.log()).not.toContain(FAKE);
    expect(r.stdout + r.stderr).not.toContain(FAKE);
    expect(e.log()).toContain("security -i");
    expect(e.log()).toContain("find-generic-password -s agent-console -a discord-bot");
  });
  it("取り消し（読み取りが失敗）なら保存せず、取り消した旨を出す", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_SECRET_INPUT: inputFile(e, "") });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("取り消しました");
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it("空白を含む値は保存しない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-report-webhook"], { AC_SECRET_INPUT: inputFile(e, "a b\n") });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it.each([
    ["二重引用符", 'a"b\n'],
    ["単一引用符", "a'b\n"],
    ["バックスラッシュ", "a\\b\n"],
  ])("%s を含む値は保存しない", async (_name, body) => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_SECRET_INPUT: inputFile(e, body) });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
    expect(e.log()).not.toContain("security -i");
  });
  it("知らない項目は保存しない", async () => {
    const e = await fresh();
    const r = e.run("ac-discord-secret.sh", ["other"], { AC_SECRET_INPUT: inputFile(e, `${FAKE}\n`) });
    expect(r.status).not.toBe(0);
    expect(e.secret()).toBe("");
  });
  it("保存の確認に失敗したら 0 以外で終わる", async () => {
    const e = await fresh();
    // find が常に失敗する security に差し替える（保存はするが確認が通らない）
    const sec = path.join(e.base, "bin", "security-nofind");
    writeFileSync(sec, `#!/bin/bash\ncase "$1" in -i) cat >/dev/null ;; *) exit 44 ;; esac\nexit 0\n`);
    chmodSync(sec, 0o755);
    const r = e.run("ac-discord-secret.sh", ["discord-bot"], { AC_SECRET_INPUT: inputFile(e, `${FAKE}\n`), AC_SECURITY: sec });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("確認できませんでした");
  });
  it("試験の印（AC_STUB_LOG）が無いとき AC_SECRET_INPUT は読まない（端末の無い試験では取り消しになる）", async () => {
    const e = await fresh();
    const { AC_STUB_LOG: _drop, ...rest } = e.env;
    void _drop;
    const r = spawnSync("bash", [path.join(process.cwd(), "scripts", "ac-discord-secret.sh"), "discord-bot"], {
      env: { ...rest, AC_SECRET_INPUT: inputFile(e, `${FAKE}\n`) },
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).not.toContain(FAKE);
    expect(e.log()).not.toContain("security -i");
    expect(e.secret()).toBe("");
  });
});
