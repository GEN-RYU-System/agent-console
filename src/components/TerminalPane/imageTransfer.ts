/** 貼り付け・ドロップの DataTransfer から、端末に添付できる画像（PNG と JPEG）を取り出す。 */

export const ATTACHABLE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg"];

export interface TransferSummary {
  /** 添付できる画像（PNG・JPEG） */
  images: File[];
  /** 画像以外のファイル（種類が空のものを含む）があるか */
  hasOtherFiles: boolean;
  /** text/plain の中身。文字があれば貼り付けは xterm に任せる */
  text: string;
}

export function classifyTransfer(dt: DataTransfer | null): TransferSummary {
  if (!dt) return { images: [], hasOtherFiles: false, text: "" };
  const files = Array.from(dt.files ?? []);
  const images = files.filter((f) => ATTACHABLE_IMAGE_TYPES.includes(f.type));
  return { images, hasOtherFiles: files.length > images.length, text: dt.getData("text/plain") };
}
