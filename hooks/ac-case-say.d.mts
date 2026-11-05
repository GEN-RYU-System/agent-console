// ac-case-say.mjs の型（試験から import するため）。本体は node の標準の部品だけで動く素の JS。
export const RESERVE_TOKEN_FILE_NAME: string;
export interface CaseSayCommandInput {
  argv: string[];
  dataDir: string;
  callerSessionId?: string;
}
export function runCommand(input: CaseSayCommandInput): Promise<{ code: 0 | 1; stdout: string; stderr: string }>;
