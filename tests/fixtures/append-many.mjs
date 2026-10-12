// activity-hook の appendRecord を、1 つのプロセスから繰り返し呼ぶ（並列書き込みの試験用）。
// 使い方: node append-many.mjs <hook.mjs> <activityDir> <procIndex> <count>
import { pathToFileURL } from "node:url";

const [hookPath, dir, procIndex, count] = process.argv.slice(2);
const { appendRecord } = await import(pathToFileURL(hookPath).href);
const NOW = Date.UTC(2026, 9, 12, 14, 0, 0);
// 1 行が 3KB を超えるように、長い題を付ける（上限 4KiB の手前）
const subject = "あ".repeat(100) + "x".repeat(100);
for (let i = 0; i < Number(count); i++) {
  const ok = appendRecord(dir, {
    ts: NOW,
    event: "TaskCreated",
    session_id: "11111111-2222-4333-8444-555555555555",
    task_id: `${procIndex}-${i}`,
    task_subject: subject,
    pad: "y".repeat(2800),
  });
  if (!ok) process.exit(1);
}
