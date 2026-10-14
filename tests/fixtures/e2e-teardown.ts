import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

/** tmux 経由の e2e が作った試験用ソケットの tmux サーバーを止め、ソケットのファイルも消す（本番のソケットには触れない） */
export default function globalTeardown(): void {
  const socket = process.env.AC_E2E_TMUX_SOCKET;
  if (!socket || !socket.startsWith("ac-test-")) return;
  const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "tmux"];
  for (const bin of tmux) {
    const r = spawnSync(bin, ["-u", "-L", socket, "kill-server"], { stdio: "ignore" });
    if (r.error === undefined) break;
  }
  rmSync(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
}
