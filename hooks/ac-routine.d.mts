// ac-routine.mjs の型（試験から import するため）。本体は node の標準の部品だけで動く素の JS。
export const RESERVE_TOKEN_FILE_NAME: string;
export interface RoutineCommandInput {
  argv: string[];
  stdinText?: string;
  dataDir: string;
  /** CLAUDE_CODE_SESSION_ID。無ければ本文に入れず、サーバーが 403 にする */
  callerSessionId?: string;
}
export function runCommand(input: RoutineCommandInput): Promise<{ code: 0 | 1; stdout: string; stderr: string }>;
