// activity-hook.mjs の型（試験とサーバーから import するため）。本体は node の標準の部品だけで動く素の JS。
export const MAX_LINE_BYTES: number;
export type ActivityRecord = Record<string, unknown> & { ts: number; event: string; session_id: string };
export function buildRecord(input: unknown, now?: number): ActivityRecord | null;
export function activityFileName(ts: number): string;
export interface AppendIo {
  writeSync?: (fd: number, buf: Buffer) => number;
}
export function appendRecord(activityDir: string, record: ActivityRecord, io?: AppendIo): boolean;
export function run(stdinText: string, dataDir: string, now?: number): boolean;
