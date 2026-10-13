import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fetchAccount, parseAccount } from "../../server/account.ts";

/** 実物の `claude auth status --json` と同じ 10 キー（K3: 画面へは 3 キーだけ） */
const REAL_SHAPE = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  projectsDirectory: "/x/projects",
  configDirectory: "/x/.claude",
  email: "someone@example.com",
  orgId: "org-secret",
  orgName: "Secret Org",
  subscriptionType: "max",
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ac-account-"));
});

/** 引数が auth status --json のときだけ out を出して code で終わる偽の claude */
function fakeClaude(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 99\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("K3: parseAccount", () => {
  it("実物と同じ 10 キーの JSON から、status・loggedIn・email・subscriptionType の 4 キーだけを返す（7 キーが落ちる）", () => {
    const result = parseAccount(JSON.stringify(REAL_SHAPE));
    expect(result).toEqual({ status: "ok", loggedIn: true, email: "someone@example.com", subscriptionType: "max" });
    expect(Object.keys(result).sort()).toEqual(["email", "loggedIn", "status", "subscriptionType"]);
    const dropped = Object.keys(REAL_SHAPE).filter((k) => !(k in result));
    expect(dropped.sort()).toEqual(["analyticsDisabled", "apiProvider", "authMethod", "configDirectory", "orgId", "orgName", "projectsDirectory"]);
  });

  it("未ログインは {status:'ok', loggedIn:false} だけ", () => {
    expect(parseAccount(JSON.stringify({ ...REAL_SHAPE, loggedIn: false }))).toEqual({ status: "ok", loggedIn: false });
  });

  it("壊れた JSON・型違い・配列は invalid", () => {
    expect(parseAccount("{broken")).toEqual({ status: "invalid" });
    expect(parseAccount("[]")).toEqual({ status: "invalid" });
    expect(parseAccount("null")).toEqual({ status: "invalid" });
    expect(parseAccount(JSON.stringify({ loggedIn: "yes" }))).toEqual({ status: "invalid" });
    expect(parseAccount(JSON.stringify({ loggedIn: true, email: 1, subscriptionType: "max" }))).toEqual({ status: "invalid" });
    expect(parseAccount(JSON.stringify({ loggedIn: true, email: "a@b.c" }))).toEqual({ status: "invalid" });
  });
});

describe("K2: fetchAccount の分岐", () => {
  it("成功（終了コード 0）は stdout を parse する", async () => {
    const bin = fakeClaude("ok.sh", `echo '${JSON.stringify(REAL_SHAPE)}'`);
    expect(await fetchAccount(bin)).toEqual({ status: "ok", loggedIn: true, email: "someone@example.com", subscriptionType: "max" });
  });

  it("未ログイン（終了コード 1 でも JSON が出る）は loggedIn:false", async () => {
    const bin = fakeClaude("out.sh", `echo '${JSON.stringify({ ...REAL_SHAPE, loggedIn: false })}'; exit 1`);
    expect(await fetchAccount(bin)).toEqual({ status: "ok", loggedIn: false });
  });

  it("失敗で stdout が空なら error", async () => {
    expect(await fetchAccount(fakeClaude("empty.sh", "exit 1"))).toEqual({ status: "error" });
  });

  it("実行できない（ENOENT）は error", async () => {
    expect(await fetchAccount(path.join(dir, "no-such-claude"))).toEqual({ status: "error" });
  });

  it("壊れた JSON は invalid（終了コード 0 でも 1 でも）", async () => {
    expect(await fetchAccount(fakeClaude("bad0.sh", "echo '{broken'"))).toEqual({ status: "invalid" });
    expect(await fetchAccount(fakeClaude("bad1.sh", "echo '{broken'; exit 1"))).toEqual({ status: "invalid" });
  });
});
