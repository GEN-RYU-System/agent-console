// board-guard.mjs の型（試験から import するため）。
export const TOOL_USE_THRESHOLD: number;
export const GUARD_DIR_NAME: string;
export const ERROR_LOG_NAME: string;
export function logError(dataDir: string, err: unknown): void;
export function isOpenSession(dataDir: string, sessionId: string): boolean;
export function reachesToolUses(transcriptPath: string, limit?: number): boolean;
export function buildReason(input: { dataDir: string; limits: Record<string, number>; invalid: boolean }): string;
export function decide(input: unknown, dataDir: string): Promise<{ decision: "block"; reason: string } | null>;
