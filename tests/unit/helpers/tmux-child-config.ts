import type { Config, RoleConfig } from "../../../server/config.ts";

export const ROLES_FOR_CHILD: RoleConfig[] = [{ id: "cat", labelKey: "role.shell", command: ["/bin/sh", "-c", "echo READY; cat"], needsWorktree: false }];

/** 子プロセスの試験用に、SessionManager が使う項目だけを持つ設定 */
export function childConfig(socket: string): Config {
  return {
    salesanchorRoot: "/tmp",
    newWorktreeScript: "x",
    terminalEnv: { LANG: "ja_JP.UTF-8" },
    ringBufferBytes: 1024 * 1024,
    roles: ROLES_FOR_CHILD,
    terminalHost: "tmux",
    tmuxSocket: socket,
  } as unknown as Config;
}
