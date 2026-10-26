// 件の写しの試験用の作り物: 元になる bare のリポジトリ B と、B から作った本店 M。M の origin は https://github.com/test/repo.git（B へは insteadOf で向ける）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FAKE_ORIGIN = "https://github.com/test/repo.git";

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

export interface CaseRepo {
  root: string;
  /** 元の bare */
  B: string;
  /** B へ commit を積む作業場所 */
  work: string;
  /** 本店（手元の main は B の main より1つ古い） */
  M: string;
  H: string;
  /** 積んだあとの B の main の sha */
  mainSha: string;
  /** M の手元の main の sha（古い） */
  localMainSha: string;
  cleanup(): void;
}

const ENV_KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2"] as const;

/** 試験の間だけ process.env で、origin の https の URL を B の file:// に向ける（extra は鍵と値を足す） */
export function pointOriginAtB(B: string, extraUrls: string[] = []): () => void {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const urls = [FAKE_ORIGIN, ...extraUrls];
  process.env.GIT_CONFIG_COUNT = String(urls.length);
  urls.forEach((u, i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = `url.file://${B}.insteadOf`;
    process.env[`GIT_CONFIG_VALUE_${i}`] = u;
  });
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** rootDir を渡すとその中に作る（M は rootDir/<mName>。ハーネスの dir/root に本店を置くため） */
export function makeCaseRepo(opts: { rootDir?: string; mName?: string } = {}): CaseRepo {
  const root = opts.rootDir ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-case-")));
  const B = path.join(root, "B.git");
  const work = path.join(root, "work");
  const M = path.join(root, opts.mName ?? "M");
  const H = path.join(root, "home");
  mkdirSync(H);
  git(root, "init", "-q", "--bare", "-b", "main", B);
  git(root, "init", "-q", "-b", "main", work);
  mkdirSync(path.join(work, ".claude-pipeline", "active-work.d"), { recursive: true });
  writeFileSync(path.join(work, ".claude-pipeline", "active-work.md"), "| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |\n");
  writeFileSync(path.join(work, ".claude-pipeline", "active-work.d", ".gitkeep"), "");
  mkdirSync(path.join(work, "frontend", ".husky"), { recursive: true });
  writeFileSync(path.join(work, "frontend", ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(work, "a.txt"), "1\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "first");
  git(work, "remote", "add", "origin", B);
  git(work, "push", "-q", "origin", "main");
  git(root, "clone", "-q", B, M);
  // 小さな試験用のリポジトリは緩い物（loose）のままなので、pack にしておく（pack のリンクの数の試験のため）
  git(M, "repack", "-a", "-d", "-q");
  git(M, "config", "--local", "user.name", "Case Tester");
  git(M, "config", "--local", "user.email", "case@example.invalid");
  git(M, "remote", "set-url", "origin", FAKE_ORIGIN);
  const localMainSha = git(M, "rev-parse", "main").trim();
  writeFileSync(path.join(work, "a.txt"), "2\n");
  git(work, "commit", "-q", "-am", "second");
  git(work, "push", "-q", "origin", "main");
  const mainSha = git(work, "rev-parse", "HEAD").trim();
  return { root, B, work, M, H, mainSha, localMainSha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** B の main に、work で作った commit を足して送る（mutate は work の中身を直す） */
export function pushToB(r: CaseRepo, message: string, mutate: () => void): string {
  mutate();
  git(r.work, "add", "-A");
  git(r.work, "commit", "-q", "--allow-empty", "-m", message);
  git(r.work, "push", "-q", "origin", "main");
  return git(r.work, "rev-parse", "HEAD").trim();
}

export { symlinkSync };
