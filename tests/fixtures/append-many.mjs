// activity-hook の appendRecord を、1 つのプロセスから繰り返し呼ぶ（並列書き込みの試験用）。
// 使い方: node append-many.mjs <hook.mjs> <activityDir> <procIndex> <count> [large]
//   large を付けると、1 行が 60KiB を超える Stop の記録（本物の buildRecord で作る）を書く。
import { pathToFileURL } from "node:url";

const [hookPath, dir, procIndex, count, mode] = process.argv.slice(2);
const { appendRecord, buildRecord } = await import(pathToFileURL(hookPath).href);
const NOW = Date.UTC(2026, 9, 12, 14, 0, 0);
const SESSION = "11111111-2222-4333-8444-555555555555";
// 1 行が 3KB を超えるように、長い題を付ける（上限は 64KiB）
const subject = "あ".repeat(100) + "x".repeat(100);
// 61KiB を超える本文（日本語と改行を混ぜる）。プロセスと連番を先頭に入れて、行の取り違えを見つけられるようにする
const bigTail = "あいうえお\nかきくけこ ".repeat(3000);
for (let i = 0; i < Number(count); i++) {
  const record =
    mode === "large"
      ? buildRecord({ session_id: SESSION, hook_event_name: "Stop", last_assistant_message: `${procIndex}-${i}\n${bigTail}` }, NOW)
      : { ts: NOW, event: "TaskCreated", session_id: SESSION, task_id: `${procIndex}-${i}`, task_subject: subject, pad: "y".repeat(2800) };
  if (record === null || !appendRecord(dir, record)) process.exit(1);
}
