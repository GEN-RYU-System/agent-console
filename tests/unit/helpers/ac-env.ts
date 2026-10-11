import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REPO = process.cwd();

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface AcEnv {
  base: string;
  home: string;
  agentsDir: string;
  appsDir: string;
  trashDir: string;
  trashed(): string[];
  stubLog: string;
  keychainFile: string;
  port: number;
  diagPort: number;
  env: Record<string, string>;
  run(script: string, args?: string[], extraEnv?: Record<string, string>): SpawnSyncReturns<string>;
  log(): string;
  secret(): string;
  cleanup(): void;
}

function stub(binDir: string, name: string, body: string): string {
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** 一時ディレクトリ＋スタブだけで導入スクリプトを通すための環境。実環境（LaunchAgents・Applications・キーチェーン）は触らない。 */
export async function makeAcEnv(): Promise<AcEnv> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-scripts-")));
  const home = path.join(base, "home", "agent-console");
  const agentsDir = path.join(base, "LaunchAgents");
  const appsDir = path.join(base, "Applications");
  const trashDir = path.join(base, "Trash");
  const binDir = path.join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const stubLog = path.join(base, "stub.log");
  const keychainFile = path.join(base, "keychain-secret");
  writeFileSync(stubLog, "");
  const port = await freePort();
  const diagPort = await freePort();
  const fixture = path.join(REPO, "tests", "fixtures", "ac", "fake-version-server.cjs");
  const pidFile = path.join(base, "fake-server.pid");

  // launchctl: bootstrap / kickstart で current の偽サーバーを本番ポートで起動、bootout で停止、print で状態
  const launchctl = stub(
    binDir,
    "launchctl",
    `echo "launchctl $*" >> "${stubLog}"
stop_server() { if [ -f "${pidFile}" ]; then kill "$(cat "${pidFile}")" 2>/dev/null || true; rm -f "${pidFile}"; sleep 0.2; fi; }
start_server() {
  stop_server
  cd "${home}/current" || exit 1
  # node 自身の pid を記録する（&& でつなげて丸ごと背景にすると $! がサブシェルの pid になり、止められなくなる）
  FAKE_MAIN=1 AGENT_CONSOLE_PORT="${port}" nohup node dist-server/server/index.js >> "${base}/fake-server.log" 2>&1 < /dev/null &
  echo $! > "${pidFile}"
}
case "$1" in
  bootstrap) start_server ;;
  kickstart) [ "\${FAKE_NO_RESTART:-}" = 1 ] || start_server ;;
  bootout) stop_server ;;
  print) if [ -f "${pidFile}" ] && kill -0 "$(cat "${pidFile}")" 2>/dev/null; then echo "	state = running"; echo "	pid = $(cat "${pidFile}")"; else echo "	state = not running"; fi ;;
esac
exit 0`,
  );

  // security: -i は標準入力のコマンドから秘密を保存（argv には出ない）。find は保存値を返す
  const security = stub(
    binDir,
    "security",
    `echo "security $*" >> "${stubLog}"
case "$1" in
  -i)
    while IFS= read -r line; do
      case "$line" in
        add-generic-password*) printf '%s' "\${line##* -w }" > "${keychainFile}" ;;
      esac
    done ;;
  find-generic-password)
    [ -f "${keychainFile}" ] || exit 44
    case " $* " in *" -w "*) cat "${keychainFile}"; echo ;; esac ;;
  delete-generic-password)
    [ -f "${keychainFile}" ] || exit 44
    : > "${keychainFile}.deleted"; mv -f "${keychainFile}" "${keychainFile}.gone" ;;
esac
exit 0`,
  );

  // gh: repo clone <repo> <dir> -- --branch <tag> --depth 1。偽の版（package.json・偽サーバー）を作る
  const gh = stub(
    binDir,
    "gh",
    `echo "gh $*" >> "${stubLog}"
if [ "$1" = api ]; then echo "\${FAKE_COMPARE_STATUS:-behind}"; exit 0; fi
[ "$1 $2" = "repo clone" ] || exit 2
dir="$4"; tag=""
while [ $# -gt 0 ]; do if [ "$1" = "--branch" ]; then tag="$2"; fi; shift; done
[ "\${FAKE_CLONE_FAIL:-}" = 1 ] && exit 1
mkdir -p "$dir/dist-server/server" "$dir/scripts"
printf '{"name":"agent-console","version":"%s"}\\n' "\${tag#v}" > "$dir/package.json"
cp "${fixture}" "$dir/dist-server/server/index.js"
echo "console.log('sa-sync stub')" > "$dir/scripts/sa-sync.mjs"
echo "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.AC_STUB_LOG, 'postinstall-ran\\n')" > "$dir/scripts/postinstall.mjs"
git -C "$dir" init -q
git -C "$dir" -c user.name=stub -c user.email=stub@example.invalid add -A
git -C "$dir" -c user.name=stub -c user.email=stub@example.invalid commit -q -m "release $tag"
exit 0`,
  );

  const npm = stub(binDir, "npm", `echo "npm $*" >> "${stubLog}"\nexit 0`);
  const osacompile = stub(
    binDir,
    "osacompile",
    `echo "osacompile $*" >> "${stubLog}"
out=""; src=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; *) src="$1" ;; esac; shift; done
mkdir -p "$out"
if [ -n "$src" ]; then cp "$src" "$out/script.applescript"; else cat > "$out/script.applescript"; fi
exit 0`,
  );
  const plutil = stub(binDir, "plutil", `echo "plutil $*" >> "${stubLog}"\nif [ -x /usr/bin/plutil ]; then exec /usr/bin/plutil "$@"; fi\nexit 0`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: path.join(base, "fakehome"),
    AC_HOME: home,
    AC_LAUNCH_AGENTS_DIR: agentsDir,
    AC_APPS_DIR: appsDir,
    AC_TRASH: trashDir,
    AC_LAUNCHCTL: launchctl,
    AC_SECURITY: security,
    AC_GH: gh,
    AC_NPM: npm,
    AC_OSACOMPILE: osacompile,
    AC_PLUTIL: plutil,
    AC_NODE: process.execPath,
    AC_PORT: String(port),
    AC_DIAG_PORT: String(diagPort),
    AC_UID: "501",
    AC_STUB_LOG: stubLog,
    AC_HEALTH_WAIT_SEC: "8",
    AC_CLAUDE: "/usr/local/bin/claude",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  mkdirSync(env.HOME, { recursive: true });

  return {
    base,
    home,
    agentsDir,
    appsDir,
    trashDir,
    trashed: () => (existsSync(trashDir) ? readdirSync(trashDir).sort() : []),
    stubLog,
    keychainFile,
    port,
    diagPort,
    env,
    run(script, args = [], extraEnv = {}) {
      return spawnSync("bash", [path.join(REPO, "scripts", script), ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 90000 });
    },
    log: () => readFileSync(stubLog, "utf8"),
    secret: () => (existsSync(keychainFile) ? readFileSync(keychainFile, "utf8") : ""),
    cleanup() {
      // 偽サーバーを止める（bootout 相当）
      spawnSync("bash", ["-c", `[ -f "${pidFile}" ] && kill "$(cat "${pidFile}")" 2>/dev/null; true`]);
    },
  };
}

export { copyFileSync };
