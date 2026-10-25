// 囲いの外で作業場所に向けて動かす git はこの上書きを通す（作業場所の設定で命令が動かない）。ADR-1039・設計 §4-5。
export const SAFE_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export function safeGitArgs(dir: string, args: readonly string[]): string[] {
  return [...SAFE_GIT_CONFIG, "-C", dir, ...args];
}
