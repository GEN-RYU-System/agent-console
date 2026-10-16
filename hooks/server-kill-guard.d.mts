// server-kill-guard.mjs の型（試験から import するため）。
export const PROD_PORT: string;
export const DENY_MESSAGE: string;
export function hasProtected(text: string): boolean;
export function commandDenied(command: string): boolean;
export function judge(input: unknown): { code: 0 | 2; stderr: string };
