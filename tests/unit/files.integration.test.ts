// file-viewer §3-4: セッションが書いたファイルの一覧と中身の口（K2・K3・K5）
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readListedFile } from "../../server/files-routes.ts";
import { startHarness, TOKEN, type Harness } from "./helpers/harness.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const A_ID = "aaaaaaaa-3333-4333-8444-555555555555";
const B_ID = "bbbbbbbb-3333-4333-8444-555555555555";

let h: Harness;
let work: string;
const headers = { Authorization: `Bearer ${TOKEN}` };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  h = await startHarness();
  work = mkdtempSync(path.join(os.tmpdir(), "ac-files-"));
});
afterAll(async () => {
  await h.close();
});

async function get(p: string, auth = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${h.base}${p}`, { headers: auth ? headers : {} });
  return { status: res.status, json: (await res.json()) as Json };
}
const dayFile = (ts: number): string => `events-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`;
function wrote(sessionId: string, file: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(h.config.dataDir, "activity");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, dayFile(Date.now())), JSON.stringify({ ts: Date.now(), event: "PostToolUse", session_id: sessionId, tool: "Write", path: file, ...extra }) + "\n");
}
function sessionWith(name: string, claudeSessionId?: string): string {
  const s = h.sessions.restore({ role: h.config.roles[0], name, cwd: h.config.salesanchorRoot, branch: null });
  if (claudeSessionId !== undefined) h.sessions.setClaudeSessionId(s.id, claudeSessionId);
  return s.id;
}
const content = (id: string, p: string) => get(`/api/sessions/${id}/files/content?path=${encodeURIComponent(p)}`);

describe("GET /api/sessions/:id/files", () => {
  it("認証が要る。存在しないセッションは 404。claudeSessionId が無ければ noSession", async () => {
    const id = sessionWith("files-none");
    expect((await get(`/api/sessions/${id}/files`, false)).status).toBe(401);
    expect((await get("/api/sessions/missing/files")).status).toBe(404);
    expect((await get(`/api/sessions/${id}/files`)).json).toEqual({ status: "noSession" });
    expect((await content(id, "/x")).json).toEqual({ status: "noSession" });
  });

  it("K2 2 セッション分の記録で一覧が混ざらない。name・dir は server が作り、新しい順", async () => {
    const a = sessionWith("files-a", A_ID);
    const b = sessionWith("files-b", B_ID);
    const fa1 = path.join(work, "a1.md");
    const fa2 = path.join(work, "sub dir", "a2.txt");
    const fb = path.join(work, "b.md");
    wrote(A_ID, fa1, { ts: Date.now() - 2000 });
    wrote(A_ID, fa2, { ts: Date.now() - 1000, agent_id: "ag" });
    wrote(B_ID, fb);
    const ra = await get(`/api/sessions/${a}/files`);
    expect(ra.json.status).toBe("ok");
    expect(ra.json.files.map((f: Json) => [f.path, f.name, f.dir, f.tool, f.byAgent])).toEqual([
      [fa2, "a2.txt", path.join(work, "sub dir"), "Write", true],
      [fa1, "a1.md", work, "Write", false],
    ]);
    expect((await get(`/api/sessions/${b}/files`)).json.files.map((f: Json) => f.path)).toEqual([fb]);
    // 別のセッションのファイルは notListed
    writeFileSync(fb, "# b");
    expect(await content(a, fb)).toEqual({ status: 404, json: { status: "notListed" } });
  });
});

describe("GET /api/sessions/:id/files/content", () => {
  const SID = "cccccccc-3333-4333-8444-555555555555";
  let id: string;
  beforeAll(() => {
    id = sessionWith("files-content", SID);
  });
  const listed = (p: string): string => {
    wrote(SID, p);
    return p;
  };

  it("読めた .md は markdown、それ以外は text。先頭の BOM は落とす", async () => {
    const md = listed(path.join(work, "r.md"));
    writeFileSync(md, "﻿# 見出し\n\n本文");
    const r = await content(id, md);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "ok", text: "# 見出し\n\n本文", kind: "markdown" });
    expect(typeof r.json.mtimeMs).toBe("number");
    const txt = listed(path.join(work, "r.log"));
    writeFileSync(txt, "plain");
    expect((await content(id, txt)).json).toMatchObject({ status: "ok", text: "plain", kind: "text", size: 5 });
    const upper = listed(path.join(work, "R.MARKDOWN"));
    writeFileSync(upper, "x");
    expect((await content(id, upper)).json.kind).toBe("markdown");
  });

  it("K3 一覧に無いパス（.. を含む・相対・未記録）は 404 notListed。path が無いのも notListed", async () => {
    const md = listed(path.join(work, "k3.md"));
    writeFileSync(md, "x");
    for (const p of [path.join(work, "other.md"), `${work}/../${path.basename(work)}/k3.md`, "k3.md", `${md}/`]) {
      expect(await content(id, p)).toEqual({ status: 404, json: { status: "notListed" } });
    }
    expect((await get(`/api/sessions/${id}/files/content`)).status).toBe(404);
  });

  it("K3/K5 消えた→missing。symlink・フォルダ・FIFO→notRegular。途中の段がファイル→unreadable", async () => {
    expect((await content(id, listed(path.join(work, "gone.md")))).json).toEqual({ status: "missing" });
    const target = path.join(work, "target.md");
    writeFileSync(target, "secret");
    const link = listed(path.join(work, "link.md"));
    symlinkSync(target, link);
    expect((await content(id, link)).json).toEqual({ status: "notRegular" });
    const dir = listed(path.join(work, "a-dir"));
    mkdirSync(dir);
    expect((await content(id, dir)).json).toEqual({ status: "notRegular" });
    const fifo = listed(path.join(work, "pipe"));
    execFileSync("mkfifo", [fifo]);
    expect((await content(id, fifo)).json).toEqual({ status: "notRegular" });
    const plain = path.join(work, "plain-file");
    writeFileSync(plain, "x");
    expect((await content(id, listed(path.join(plain, "child.md")))).json).toEqual({ status: "unreadable" });
  });

  it("K5 1 MiB を超える→tooLarge（中身は出さない）。ちょうど 1 MiB は読める", async () => {
    const big = listed(path.join(work, "big.txt"));
    writeFileSync(big, "a".repeat(1024 * 1024 + 1));
    const r = await content(id, big);
    expect(r.json).toEqual({ status: "tooLarge", size: 1024 * 1024 + 1 });
    const edge = listed(path.join(work, "edge.txt"));
    writeFileSync(edge, "a".repeat(1024 * 1024));
    expect((await content(id, edge)).json).toMatchObject({ status: "ok", size: 1024 * 1024 });
  });

  it("K5 NUL を含む・UTF-8 として読めない→binary（中身は出さない）", async () => {
    const nul = listed(path.join(work, "nul.bin"));
    writeFileSync(nul, Buffer.from([0x41, 0x00, 0x42]));
    expect((await content(id, nul)).json).toEqual({ status: "binary", size: 3 });
    const bad = listed(path.join(work, "bad.txt"));
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x41]));
    expect((await content(id, bad)).json).toEqual({ status: "binary", size: 3 });
  });
});

describe("readListedFile: 読んでいる途中で伸びた場合も上限で止める", () => {
  it("上限 + 1 byte までしか読まず tooLarge", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "ac-files-grow-"));
    const f = path.join(d, "g.txt");
    writeFileSync(f, "a".repeat(20));
    expect(await readListedFile(f, 10)).toEqual({ status: "tooLarge", size: 20 });
    expect(await readListedFile(f, 20)).toMatchObject({ status: "ok", size: 20 });
  });
});
