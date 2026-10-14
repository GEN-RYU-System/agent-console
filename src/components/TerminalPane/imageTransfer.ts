/** 貼り付け・ドロップの DataTransfer から、端末に添付するファイルを元の順に取り出す（PNG・JPEG は image、それ以外は file）。 */

export const ATTACHABLE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg"];

export interface TransferFile {
  file: File;
  /** image = PNG・JPEG（画像の口へ）。file = それ以外（種類が空を含む。ファイルの口へ） */
  kind: "image" | "file";
}

export interface TransferSummary {
  /** ドロップ・貼り付けされたファイル。元の順のまま */
  files: TransferFile[];
  /** text/plain の中身。文字があれば貼り付けは xterm に任せる */
  text: string;
}

export function classifyTransfer(dt: DataTransfer | null): TransferSummary {
  if (!dt) return { files: [], text: "" };
  const files = Array.from(dt.files ?? []).map((file): TransferFile => ({
    file,
    kind: ATTACHABLE_IMAGE_TYPES.includes(file.type) ? "image" : "file",
  }));
  return { files, text: dt.getData("text/plain") };
}
