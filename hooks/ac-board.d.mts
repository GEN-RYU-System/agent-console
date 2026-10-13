// ac-board.mjs の型（試験とサーバーから import するため）。本体は node の標準の部品だけで動く素の JS。
export const BOARD_VERSION: 1;
export const BOARDS_DIR_NAME: string;
export const BOARD_LIMITS: Readonly<{ themeChars: number; kgiItems: number; kgiChars: number; kpiItems: number; kpiChars: number; roadmapItems: number; roadmapChars: number; taskItems: number; taskChars: number }>;

export type BoardStatus = "todo" | "doing" | "done";
/** 命令に渡す形（version と updatedAt は命令が付ける） */
export interface BoardInput {
  theme: string;
  kgi: Array<{ text: string }>;
  kpis: Array<{ name: string; target: string; current: string; unit: string }>;
  roadmap: Array<{ title: string; status: BoardStatus }>;
  /** 省ける（省いたら 0 件） */
  tasks?: Array<{ title: string; status: BoardStatus }>;
}
/** 保存される形（tasks は必ず入る） */
export interface StoredBoard extends BoardInput {
  tasks: Array<{ title: string; status: BoardStatus }>;
  version: 1;
  updatedAt: number;
}

/** 検査を通った形（tasks は必ず入る） */
export type StoredBoardBody = Required<BoardInput>;
export type ValidateResult = { ok: true; board: StoredBoardBody } | { ok: false; reason: string };
export function validateBoard(input: unknown): ValidateResult;
export function boardPathFor(boardsDir: string, sessionId: string): string | null;
export type WriteResult = { ok: true; path: string } | { ok: false; reason: string };
export function writeBoard(dataDir: string, sessionId: string, input: unknown, now?: number): WriteResult;
export type ReadResult = { status: "none" } | { status: "invalid" } | { status: "ok"; board: StoredBoard };
export function readBoard(dataDir: string, sessionId: string): ReadResult;
export interface CommandInput {
  argv: string[];
  env: Record<string, string | undefined>;
  stdinText: string;
  dataDir: string;
  now?: number;
}
export function runCommand(input: CommandInput): { code: 0 | 1; stdout: string; stderr: string };
