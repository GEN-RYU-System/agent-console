// 試験用: tmux の中に端末を 1 つ作って pid を出力し、そのまま居座る小さなサーバー役（SIGKILL される側）
import path from "node:path";
import { ROLES_FOR_CHILD, childConfig } from "./tmux-child-config.ts";
import { SessionManager } from "../../../server/sessions.ts";

const socket = process.argv[2];
const manager = new SessionManager(childConfig(socket), { tmuxConf: path.join(process.cwd(), "ops", "tmux", "agent-console.tmux.conf") });
const session = manager.restore({ role: ROLES_FOR_CHILD[0], name: "child", cwd: "/tmp", branch: null });
console.log(`PID=${session.term.pid}`);
setInterval(() => undefined, 1000);
