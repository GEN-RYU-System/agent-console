// ac-statusline.mjs の型（試験とサーバーから import するため）。本体は node の標準の部品だけで動く素の JS。
export const USAGE_VERSION: 1;
export const USAGE_FILE_NAME: string;

export interface UsageWindow {
  /** 0〜100 */
  usedPercentage: number;
  /** Unix 秒 */
  resetsAt: number;
}
/** 窓は個別に欠けることがある（少なくとも 1 つは入る） */
export interface UsageBody {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}
export function extractUsage(input: unknown): UsageBody | null;
export function formatLine(usage: UsageBody | null | undefined): string;
export function sweepStaleTmp(dataDir: string, fileName: string, now?: number): number;
export function writeUsage(dataDir: string, usage: UsageBody, now?: number): string;
export type UsageReadResult = { status: "none" } | { status: "invalid" } | ({ status: "ok"; observedAt: number } & UsageBody);
export function readUsage(dataDir: string): UsageReadResult;
export function runStatusline(input: { stdinText: string; dataDir: string; now?: number }): { code: 0; stdout: string };

export const SESSION_METRICS_VERSION: 1;
export const SESSION_METRICS_FILE_NAME: string;
export const SESSION_METRICS_FRESH_MS: number;
export interface SessionMetric {
  /** 0〜100（Mac 全体を 100 とした割合） */
  cpuPercent: number;
  /** 0〜100。分からなければ null */
  ramPercent: number | null;
}
export function writeSessionMetrics(dataDir: string, sessions: Record<string, SessionMetric>, now?: number): string;
export function readSessionMetrics(dataDir: string, sessionId: unknown, now?: number): SessionMetric | null;
export function formatMetrics(metrics: SessionMetric | null | undefined): string;
export function runMetrics(input: { stdinText: string; dataDir: string; now?: number }): { code: 0; stdout: string };
