import { createHmac } from "node:crypto";

// 相互認証の証明。形式は ops/launcher/pair-proof.mjs と同一（pair-proof.test.ts で一致を検証）。
//   proof_s = HMAC-SHA256(secret, "server|" + cnonce + "|" + snonce)   サーバー → launcher
//   proof_c = HMAC-SHA256(secret, "client|" + snonce + "|" + cnonce)   launcher → サーバー

export function serverProof(secret: string, cnonce: string, snonce: string): string {
  return createHmac("sha256", secret).update(`server|${cnonce}|${snonce}`).digest("hex");
}

export function clientProof(secret: string, cnonce: string, snonce: string): string {
  return createHmac("sha256", secret).update(`client|${snonce}|${cnonce}`).digest("hex");
}
