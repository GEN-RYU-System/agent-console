// ac-routine-guard.mjs の型（試験から import するため）。
export const GUARDED_FRAGMENT: string;
export const TOKEN_FRAGMENT: string;
export const DATA_DIR_FRAGMENT: string;
export const DENY_MESSAGE: string;
export function bashDenied(command: string): boolean;
export function judge(input: unknown): { code: 0 | 2; stderr: string };
