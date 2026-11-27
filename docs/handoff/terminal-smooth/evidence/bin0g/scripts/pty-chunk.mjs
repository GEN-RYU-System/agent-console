// macOS の pty で、子が 1 回で書いた 5000 バイトがいくつに分かれて読めるか
import pty from "node-pty";
const p = pty.spawn("/usr/bin/python3", ["-c", "import os,time; time.sleep(0.3); os.write(1, b'x'*5000); time.sleep(0.5)"], { cols: 120, rows: 40 });
const sizes = []; p.onData((d) => sizes.push(d.length)); p.onExit(() => { console.log("chunks", sizes.length, JSON.stringify(sizes)); process.exit(0); });
