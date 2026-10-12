import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const here = path.dirname(new URL(import.meta.url).pathname);
const STUB = path.join(here, "..", "fixtures", "gh-stub.sh");

let h: Harness;
let root: string;
let fxDir: string;
let logFile: string;

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function api(method: string, p: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { method, headers, body: method === "POST" ? "{}" : undefined });
  return { status: res.status, json: (await res.json()) as Json };
}
const getPr = (id: string) => api("GET", `/api/sessions/${id}/pr`);
const refreshPr = (id: string) => api("POST", `/api/sessions/${id}/pr/refresh`);
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

/** 偽 gh の出力を置く。key 付きは list = ブランチ名の「/」を「_」にしたもの、view / checks = PR 番号 */
function fx(name: string, content: string): void {
  writeFileSync(path.join(fxDir, name), content);
}
const json = (v: unknown): string => JSON.stringify(v);
const listRow = (number: number, state: "OPEN" | "MERGED" | "CLOSED", over: Json = {}): Json => ({
  number,
  title: `title ${number}`,
  state,
  isDraft: false,
  url: `https://github.com/example/repo/pull/${number}`,
  updatedAt: "2026-10-12T00:00:00Z",
  ...over,
});
const check = (bucket: string, name: string, over: Json = {}): Json => ({
  name,
  state: bucket.toUpperCase(),
  bucket,
  link: `https://github.com/example/repo/actions/runs/1/job/${name}`,
  workflow: "ci",
  completedAt: "2026-10-12T00:00:00Z",
  ...over,
});
/** ブランチ branch に PR n がある状態を置く（view の mergeStateStatus と checks も） */
function setPr(branch: string, n: number, state: "OPEN" | "MERGED" | "CLOSED", checks: Json[] | null, over: Json = {}): void {
  fx(`list@${branch.replace(/\//g, "_")}.out`, json([listRow(n, state, over)]));
  fx(`view@${n}.out`, json({ ...listRow(n, state, over), mergeStateStatus: "CLEAN", headRefName: branch }));
  if (checks !== null) fx(`checks@${n}.out`, json(checks));
}
function clearFx(): void {
  for (const f of readdirSync(fxDir)) rmSync(path.join(fxDir, f));
  writeFileSync(logFile, "");
}
const calls = (): string[] =>
  readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(" | ")[0]);
const callsOf = (sub: string): string[] => calls().filter((c) => c.startsWith(`pr ${sub} `));

let wtCounter = 0;
function newPlace(branch: string): { id: string; dir: string } {
  const dir = path.join(h.dir, `wt-${wtCounter++}`);
  git(root, "worktree", "add", "-q", "-b", branch, dir);
  const s = h.sessions.restore({ role: h.config.roles[0], name: branch.slice(0, 30), cwd: dir, branch: null });
  return { id: s.id, dir: realpathSync(dir) };
}
async function ciOf(id: string): Promise<string | undefined> {
  const snap = await h.hub.snapshot();
  return (snap.sessions.find((s) => s.id === id) as Json | undefined)?.ci;
}

beforeAll(async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ac-pr-stub-"));
  fxDir = path.join(base, "fx");
  mkdirSync(fxDir);
  logFile = path.join(base, "gh.log");
  writeFileSync(logFile, "");
  process.env.STUB_GH_DIR = fxDir;
  process.env.STUB_GH_LOG = logFile;
  chmodSync(STUB, 0o755);
  h = await startHarness({ ghBin: STUB, prRefreshMinMs: 0, ghTimeoutMs: 1500, maxSessions: 40 });
  root = realpathSync(path.join(h.dir, "root"));
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
});
beforeEach(async () => {
  // 前の試験のセッションが定期の取り直しに混ざらないよう、毎回閉じる
  await Promise.all(h.sessions.list().map((s) => h.sessions.close(s.id)));
});
afterAll(async () => {
  await h.close();
});

describe("K1/K2: PR の状態と検査の集計", () => {
  it("GET は gh を呼ばず、写しが無いうちは loading を返す。「更新」で取り直すと PR・マージできるか・集計・失敗/取り消し/実行中の一覧が出る", async () => {
    clearFx();
    const { id } = newPlace("release/pr-a");
    setPr("release/pr-a", 12, "OPEN", [
      check("pass", "ok1"),
      check("pass", "ok2"),
      check("skipping", "skip1"),
      check("fail", "red-1"),
      check("cancel", "gone-1"),
      check("pending", "slow-1", { link: "javascript:alert(1)" }),
    ]);
    const first = await getPr(id);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ status: "loading" });
    expect(calls()).toEqual([]);

    const res = await refreshPr(id);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
    expect(res.json.pr).toEqual({
      number: 12,
      title: "title 12",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/example/repo/pull/12",
      mergeStateStatus: "CLEAN",
    });
    expect(res.json.checks.counts).toEqual({ pass: 2, fail: 1, pending: 1, skipping: 1, cancel: 1 });
    expect(res.json.checks.items).toEqual([
      { name: "red-1", bucket: "fail", link: "https://github.com/example/repo/actions/runs/1/job/red-1", workflow: "ci" },
      { name: "gone-1", bucket: "cancel", link: "https://github.com/example/repo/actions/runs/1/job/gone-1", workflow: "ci" },
      { name: "slow-1", bucket: "pending", link: "", workflow: "ci" }, // K8: github.com 以外のリンクは空にする
    ]);
    expect(typeof res.json.fetchedAt).toBe("number");

    // 取り直した後の GET は写しを返すだけで gh を呼ばない
    const before = calls().length;
    const again = await getPr(id);
    expect(again.json).toEqual(res.json);
    expect(calls().length).toBe(before);
  });

  it("gh へ渡す引数は設計どおりで、使うのは pr list / view / checks だけ（K7）", async () => {
    clearFx();
    const { id } = newPlace("release/pr-args");
    setPr("release/pr-args", 21, "OPEN", [check("pass", "a")]);
    await refreshPr(id);
    expect(calls()).toEqual([
      "pr list -R example/repo --head release/pr-args --state all --limit 5 --json number,title,state,isDraft,url,updatedAt",
      "pr view 21 -R example/repo --json number,title,state,isDraft,url,mergeStateStatus,headRefName",
      "pr checks 21 -R example/repo --json name,state,bucket,link,workflow,completedAt",
    ]);
    for (const c of calls()) expect(c).toMatch(/^pr (list|view|checks) /);
    // 子プロセスの環境（問い合わせで止まらない・更新の通知を混ぜない）
    for (const l of readFileSync(logFile, "utf8").trim().split("\n")) expect(l).toMatch(/GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1$/);
  });

  it("PR の url が https://github.com/ でなければ空にして返す（K8 サーバー側）", async () => {
    clearFx();
    const { id } = newPlace("release/pr-url");
    setPr("release/pr-url", 31, "OPEN", [], { url: "javascript:alert(1)" });
    const res = await refreshPr(id);
    expect(res.json.pr.url).toBe("");
  });

  it("同じブランチに複数の PR があるとき、open の中で updatedAt が最新のものを選ぶ。open が無ければ全体で最新", async () => {
    clearFx();
    const { id } = newPlace("release/pr-multi");
    fx(
      "list@release_pr-multi.out",
      json([
        listRow(41, "MERGED", { updatedAt: "2026-10-12T09:00:00Z" }),
        listRow(42, "OPEN", { updatedAt: "2026-10-11T00:00:00Z" }),
        listRow(43, "OPEN", { updatedAt: "2026-10-12T00:00:00Z" }),
        listRow(44, "CLOSED", { updatedAt: "2026-10-12T10:00:00Z" }),
      ]),
    );
    fx("view@43.out", json({ ...listRow(43, "OPEN"), mergeStateStatus: "BEHIND", headRefName: "release/pr-multi" }));
    fx("checks@43.out", "[]");
    const open = await refreshPr(id);
    expect(open.json.pr.number).toBe(43);
    expect(open.json.pr.mergeStateStatus).toBe("BEHIND");

    clearFx();
    fx("list@release_pr-multi.out", json([listRow(41, "MERGED", { updatedAt: "2026-10-12T09:00:00Z" }), listRow(44, "CLOSED", { updatedAt: "2026-10-12T10:00:00Z" })]));
    fx("checks@44.out", "[]");
    const none = await refreshPr(id);
    expect(none.json.pr.number).toBe(44);
    expect(callsOf("view")).toEqual([]);
  });

  it("マージ済みの PR では pr view を呼ばない", async () => {
    clearFx();
    const { id } = newPlace("release/pr-merged");
    setPr("release/pr-merged", 51, "MERGED", [check("pass", "a")]);
    const res = await refreshPr(id);
    expect(res.json.pr.state).toBe("MERGED");
    expect(callsOf("view")).toEqual([]);
    expect(callsOf("checks")).toHaveLength(1);
  });

  it("検査が 0 件の PR（gh は exit 1 で 'no checks reported'）は集計がすべて 0 の ok になる", async () => {
    clearFx();
    const { id } = newPlace("release/pr-nochecks");
    setPr("release/pr-nochecks", 61, "OPEN", null);
    fx("checks@61.exit", "1");
    fx("checks@61.err", "no checks reported on the 'release/pr-nochecks' branch\n");
    const res = await refreshPr(id);
    expect(res.json.status).toBe("ok");
    expect(res.json.checks).toEqual({ counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 }, items: [] });
    expect(await ciOf(id)).toBeUndefined();
  });
});

describe("K3: セッション一覧の CI の印（snapshot の ci）", () => {
  it("失敗か取り消しがあれば fail、なければ実行中があれば pending、すべて成功かスキップなら pass、PR が無ければ無し", async () => {
    clearFx();
    const cases: Array<[string, number, Json[], string | undefined]> = [
      ["release/ci-fail", 71, [check("pass", "a"), check("fail", "b"), check("pending", "c")], "fail"],
      ["release/ci-cancel", 72, [check("pass", "a"), check("cancel", "b")], "fail"],
      ["release/ci-pending", 73, [check("pass", "a"), check("pending", "c")], "pending"],
      ["release/ci-pass", 74, [check("pass", "a"), check("skipping", "b")], "pass"],
    ];
    const ids: string[] = [];
    for (const [branch, n, checks] of cases) {
      ids.push(newPlace(branch).id);
      setPr(branch, n, "OPEN", checks);
    }
    const none = newPlace("release/ci-nopr");
    fx("list@release_ci-nopr.out", "[]");
    for (const id of [...ids, none.id]) await refreshPr(id);
    for (const [i, [, , , expected]] of cases.entries()) expect(await ciOf(ids[i]), cases[i][0]).toBe(expected);
    expect(await ciOf(none.id)).toBeUndefined();
  });
});

describe("K4: PR が無い・GitHub でない・作業場所が対象外", () => {
  it("PR が無いブランチは noPr（検査は取りに行かない）", async () => {
    clearFx();
    const { id } = newPlace("release/pr-none");
    fx("list@release_pr-none.out", "[]");
    const res = await refreshPr(id);
    expect(res.json.status).toBe("noPr");
    expect(callsOf("checks")).toEqual([]);
  });

  it("origin が GitHub でない作業場所は notGitHub（gh を呼ばない）。origin が無くても同じ", async () => {
    clearFx();
    const { id } = newPlace("release/pr-nogh");
    git(root, "remote", "set-url", "origin", "https://gitlab.example.com/a/b.git");
    try {
      expect((await refreshPr(id)).json.status).toBe("notGitHub");
      expect((await getPr(id)).json.status).toBe("notGitHub");
      git(root, "remote", "remove", "origin");
      expect((await refreshPr(id)).json.status).toBe("notGitHub");
    } finally {
      const remotes = git(root, "remote").split("\n");
      if (remotes.includes("origin")) git(root, "remote", "set-url", "origin", "https://github.com/example/repo.git");
      else git(root, "remote", "add", "origin", "https://github.com/example/repo.git");
    }
    expect(calls()).toEqual([]);
  });

  it("どのブランチにもいない作業場所は detached（gh を呼ばない）", async () => {
    clearFx();
    const dir = path.join(h.dir, `wt-${wtCounter++}`);
    git(root, "worktree", "add", "-q", "--detach", dir);
    const s = h.sessions.restore({ role: h.config.roles[0], name: "detached", cwd: dir, branch: null });
    expect((await refreshPr(s.id)).json.status).toBe("detached");
    expect((await getPr(s.id)).json.status).toBe("detached");
    expect(calls()).toEqual([]);
  });

  it("本店でも worktree でもない作業場所は 409 で、gh を呼ばない（GET も POST も）", async () => {
    clearFx();
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-pr-outside-")));
    execFileSync("git", ["init", "-q"], { cwd: outside });
    const s = h.sessions.restore({ role: h.config.roles[0], name: "outside", cwd: outside, branch: null });
    expect((await getPr(s.id)).status).toBe(409);
    expect((await refreshPr(s.id)).status).toBe(409);
    expect(calls()).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("存在しないセッションは 404", async () => {
    expect((await getPr("no-such-id")).status).toBe(404);
    expect((await refreshPr("no-such-id")).status).toBe(404);
  });

  it("認証なしは 401", async () => {
    const res = await fetch(`${h.base}/api/sessions/x/pr`);
    expect(res.status).toBe(401);
  });
});

describe("K5: 取り直し", () => {
  it("同じ作業場所のセッションが 2 つあっても、定期の取り直しで gh を呼ぶのは 1 回分（pr list 1 回）", async () => {
    clearFx();
    const a = newPlace("release/poll-same");
    h.sessions.restore({ role: h.config.roles[0], name: "twin", cwd: a.dir, branch: null });
    setPr("release/poll-same", 81, "OPEN", [check("pass", "a")]);
    await h.hub.pollPrs();
    expect(callsOf("list")).toHaveLength(1);
    expect(callsOf("checks")).toHaveLength(1);
    // 2 つのセッションとも、同じ結果が見える
    const snap = await h.hub.snapshot();
    const twins = snap.sessions.filter((s) => s.cwd === a.dir);
    expect(twins).toHaveLength(2);
    for (const s of twins) expect((s as Json).ci).toBe("pass");
  });

  it("マージ済みで実行中の検査が無い PR は、その後の定期では取り直さない。実行中の検査があれば取り直す。open は取り直す", async () => {
    clearFx();
    newPlace("release/poll-merged");
    setPr("release/poll-merged", 91, "MERGED", [check("pass", "a")]);
    await h.hub.pollPrs();
    const afterFirst = calls().filter((c) => c.includes("poll-merged") || c.includes(" 91 ")).length;
    expect(afterFirst).toBeGreaterThan(0);
    const mark = calls().length;
    await h.hub.pollPrs();
    // 他のセッションの分は増えるが、poll-merged / PR 91 の呼び出しは増えない
    const after = calls().slice(mark).filter((c) => c.includes("poll-merged") || c.includes(" 91 "));
    expect(after).toEqual([]);

    // 実行中の検査が残るマージ済みは取り直す
    clearFx();
    newPlace("release/poll-merged-pending");
    setPr("release/poll-merged-pending", 92, "MERGED", [check("pending", "a")]);
    await h.hub.pollPrs();
    const m2 = calls().length;
    await h.hub.pollPrs();
    expect(calls().slice(m2).filter((c) => c.includes("poll-merged-pending"))).toHaveLength(1);

    // クローズ済みで検査が終わっているものは止める
    clearFx();
    newPlace("release/poll-closed");
    setPr("release/poll-closed", 93, "CLOSED", [check("fail", "a")]);
    await h.hub.pollPrs();
    const m3 = calls().length;
    await h.hub.pollPrs();
    expect(calls().slice(m3).filter((c) => c.includes("poll-closed"))).toEqual([]);

    // open は毎回取り直す
    clearFx();
    newPlace("release/poll-open");
    setPr("release/poll-open", 94, "OPEN", [check("pass", "a")]);
    await h.hub.pollPrs();
    const m4 = calls().length;
    await h.hub.pollPrs();
    expect(calls().slice(m4).filter((c) => c.includes("poll-open"))).toHaveLength(1);
  });

  it("止めた PR も、ブランチが変わると取り直す。「更新」ボタンでも取り直せる（開き直した PR を拾う）", async () => {
    clearFx();
    const p = newPlace("release/poll-switch");
    setPr("release/poll-switch", 101, "MERGED", [check("pass", "a")]);
    await h.hub.pollPrs();
    await h.hub.pollPrs();
    expect(callsOf("list").filter((c) => c.includes("poll-switch"))).toHaveLength(1);
    // ブランチを変える
    git(p.dir, "switch", "-q", "-c", "release/poll-switch-2");
    fx("list@release_poll-switch-2.out", "[]");
    await h.hub.pollPrs();
    expect(callsOf("list").filter((c) => c.includes("poll-switch-2"))).toHaveLength(1);
    // 同じブランチを開き直した、を「更新」で拾う
    git(p.dir, "switch", "-q", "release/poll-switch");
    setPr("release/poll-switch", 102, "OPEN", [check("pass", "a")]);
    const res = await refreshPr(p.id);
    expect(res.json.pr.number).toBe(102);
  });

  it("終了したセッションの写しは定期の掃除で消えず、その PR タブは直前の結果を返し続ける", async () => {
    clearFx();
    const { id } = newPlace("release/exited-keep");
    setPr("release/exited-keep", 131, "OPEN", [check("pass", "a")]);
    const before = await refreshPr(id);
    expect(before.json.status).toBe("ok");
    const session = h.sessions.get(id);
    session?.term.kill();
    for (let i = 0; i < 50 && !session?.exited; i++) await new Promise((r) => setTimeout(r, 100));
    expect(session?.exited).toBe(true);
    await h.hub.pollPrs();
    const after = await getPr(id);
    expect(after.json).toEqual(before.json);
  });

  it("「更新」は前回から prRefreshMinMs 以内なら取り直さず、今の結果を返す", async () => {
    clearFx();
    const { id } = newPlace("release/refresh-min");
    setPr("release/refresh-min", 111, "OPEN", [check("pass", "a")]);
    h.config.prRefreshMinMs = 60000;
    try {
      const one = await refreshPr(id);
      const n = calls().length;
      const two = await refreshPr(id);
      expect(calls().length).toBe(n);
      expect(two.json).toEqual(one.json);
    } finally {
      h.config.prRefreshMinMs = 0;
    }
  });

  it("定期と「更新」、「更新」同士が同時に走っても、同じ (repo, branch) の gh は 1 本にまとめる", async () => {
    clearFx();
    const { id } = newPlace("release/inflight");
    setPr("release/inflight", 121, "OPEN", [check("pass", "a")]);
    fx("list@release_inflight.delay", "0.5");
    const [a, b] = await Promise.all([refreshPr(id), refreshPr(id), h.hub.pollPrs()]);
    expect(callsOf("list")).toHaveLength(1);
    expect(a.json).toEqual(b.json);
  });
});

describe("K6: gh が失敗したとき", () => {
  const stubFail = (branch: string, exit: number, err: string): void => {
    const k = branch.replace(/\//g, "_");
    fx(`list@${k}.exit`, String(exit));
    fx(`list@${k}.err`, err);
  };

  it("exit 4 は authRequired", async () => {
    clearFx();
    const { id } = newPlace("release/fail-auth");
    stubFail("release/fail-auth", 4, "To get started with GitHub CLI, please run:  gh auth login\n");
    const res = await refreshPr(id);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("authRequired");
  });

  it("gh が見つからないと ghMissing", async () => {
    clearFx();
    const { id } = newPlace("release/fail-missing");
    h.config.ghBin = "/nonexistent/gh";
    try {
      expect((await refreshPr(id)).json.status).toBe("ghMissing");
    } finally {
      h.config.ghBin = STUB;
    }
  });

  it("時間切れは timeout", async () => {
    clearFx();
    const { id } = newPlace("release/fail-timeout");
    fx("list@release_fail-timeout.delay", "5");
    const started = Date.now();
    const res = await refreshPr(id);
    expect(res.json.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it("その他の失敗は ghFailed で、画面の応答には stderr を含めない（サーバーの記録にだけ残す）", async () => {
    clearFx();
    const { id } = newPlace("release/fail-other");
    stubFail("release/fail-other", 1, "boom-secret-detail\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await refreshPr(id);
      expect(res.json.status).toBe("ghFailed");
      expect(JSON.stringify(res.json)).not.toContain("boom-secret-detail");
      expect(spy.mock.calls.flat().join(" ")).toContain("boom-secret-detail");
    } finally {
      spy.mockRestore();
    }
  });

  it("利用の上限に当たったら rateLimited を返し、その回の定期の残りはやめる。アプリは動き続ける", async () => {
    clearFx();
    const x = newPlace("release/rl-a");
    const y = newPlace("release/rl-b");
    // どのブランチの list も上限に当たる（共通の fixture）
    fx("list.exit", "1");
    fx("list.err", "GraphQL: API rate limit exceeded for user ID 1.\n");
    await h.hub.pollPrs();
    // この回で pr list を呼んだのは 1 回だけ（他に open の PR を持つセッションがあっても、そこで止まる）
    expect(callsOf("list")).toHaveLength(1);
    const states = [(await getPr(x.id)).json.status, (await getPr(y.id)).json.status].sort();
    expect(states).toContain("rateLimited");
    // 次の定期では再び取りに行く（止まったままにならない）
    fx("list.exit", "0");
    fx("list.err", "");
    fx("list.out", "[]");
    await h.hub.pollPrs();
    expect(callsOf("list").length).toBeGreaterThan(1);
    expect((await getPr(x.id)).status).toBe(200);
  });
});
