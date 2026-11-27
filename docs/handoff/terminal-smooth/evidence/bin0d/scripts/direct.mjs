// 便0d: 端末も中継も無しで Claude を直接動かし、便0c と同じ送り時刻のホイール信号を送って、出力の止まりを測る
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/tmp/ac-smooth0b/v056/node_modules/");
const pty = require("node-pty");
const [rawF, outF] = process.argv.slice(2);
const d = JSON.parse(readFileSync(rawF, "utf8"));
const SID = "5dc7aa19-47c8-498f-aa23-dd121e620042";
const env = { ...process.env, TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" };
for (const k of Object.keys(env)) if (/^(TMUX|AGENT_CONSOLE|AC_|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)/.test(k)) delete env[k];
const now = () => performance.timeOrigin + performance.now();
const p = pty.spawn("/bin/sh", ["-c", `cd /private/tmp/ac-smooth0b/proj && exec claude --resume ${SID}`], { name: "xterm-256color", cols: 99, rows: 39, cwd: "/private/tmp/ac-smooth0b/proj", env });
const chunks = []; let all = "";
p.onData((s) => { chunks.push({ t: now(), n: s.length }); all += s; if (/\x1b\[6n/.test(s)) p.write("\x1b[1;1R"); if (/\x1b\[c/.test(s)) p.write("\x1b[?62;22c"); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = async (ms, max) => { const st = now(); while (now() - st < max) { const last = chunks.at(-1)?.t ?? 0; if (now() - last > ms) return; await wait(50); } };
await wait(3000); await quiet(1500, 20000);
if (/trust this folder/i.test(all.slice(-20000))) { p.write("\r"); await wait(2000); await quiet(1500, 20000); }
const modes = [...new Set((all.match(/\x1b\[\?[0-9;]+[hl]/g) || []))];
const res = { modes, scenarios: [] };
for (const s of d.scenarios.filter((x) => x.group === "B-1notch" || x.group === "C-30notch")) {
  await quiet(800, 5000);
  const b = s.dir < 0 ? 64 : 65; const t0 = s.send[0].t;
  const start = now(); const i0 = chunks.length;
  for (const se of s.send) {
    const due = start + (se.t - t0); while (now() < due - 1) await wait(Math.max(0, due - now() - 1));
    p.write(`\x1b[<${b};50;20M`.repeat(se.n || 1));
  }
  await quiet(800, 5000);
  const c = chunks.slice(i0).map((x) => x.t);
  res.scenarios.push({ group: s.group, dir: s.dir, start, sendEnd: now(), chunks: c, bytes: chunks.slice(i0).reduce((a, x) => a + x.n, 0) });
  console.log(s.group, s.dir, "chunks", c.length);
}
writeFileSync(outF, JSON.stringify(res));
p.kill(); process.exit(0);
