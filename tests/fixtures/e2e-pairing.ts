import { expect } from "@playwright/test";
import { clientProof } from "../../server/pair-proof";
import { E2E_PORT, E2E_TOKEN } from "./e2e-env";

/** launcher と同じ相互認証（チャレンジ → サーバー証明の検証 → クライアント証明）で 1 回限りコードを発行する。 */
export async function newPairingCode(port: number = E2E_PORT): Promise<string> {
  const BASE = `http://127.0.0.1:${port}`;
  const cnonce = "ab".repeat(16);
  const challenge = await fetch(`${BASE}/api/pair/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cnonce }) });
  expect(challenge.status).toBe(200);
  const { snonce } = (await challenge.json()) as { snonce: string };
  const res = await fetch(`${BASE}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cnonce, snonce, proof: clientProof(E2E_TOKEN, cnonce, snonce) }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}
