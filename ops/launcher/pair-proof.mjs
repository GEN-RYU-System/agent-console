// 相互認証の HMAC 計算（launcher から呼ぶ）。秘密は標準入力で受け取り、引数・標準出力・標準エラーに出さない。
// 使い方: printf '%s' "$secret" | node pair-proof.mjs exchange <cnonce> <snonce> <server_proof>
//   サーバーの proof_s を検証し、一致したときだけ proof_c を標準出力へ出す。不一致・不正入力は終了コード 1（何も出さない）。
// 形式は server/pair-proof.ts と同一。
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const HEX_NONCE = /^[0-9a-f]{32,128}$/;
const HEX_PROOF = /^[0-9a-f]{64}$/;

function fail(message) {
  process.stderr.write(`pair-proof: ${message}\n`);
  process.exit(1);
}

const [command, cnonce, snonce, serverProofGiven, ...extra] = process.argv.slice(2);
if (command !== "exchange" || extra.length > 0) fail("使い方: exchange <cnonce> <snonce> <server_proof>");
if (!HEX_NONCE.test(cnonce ?? "") || !HEX_NONCE.test(snonce ?? "") || !HEX_PROOF.test(serverProofGiven ?? "")) fail("引数の形式が不正です");

const secret = readFileSync(0, "utf8").trim();
if (secret === "") fail("秘密が空です");

const hmac = (message) => createHmac("sha256", secret).update(message).digest();
const expected = hmac(`server|${cnonce}|${snonce}`);
const given = Buffer.from(serverProofGiven, "hex");
if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail("サーバーの証明が一致しません（偽のサーバーの可能性）。中止します");

process.stdout.write(`${hmac(`client|${snonce}|${cnonce}`).toString("hex")}\n`);
