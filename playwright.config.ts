import { defineConfig } from "@playwright/test";
import { E2E_PORT, E2E_TMUX_PORT, E2E_TOKEN, prepareE2eEnv } from "./tests/fixtures/e2e-env";

prepareE2eEnv();

const stubEnv = {
  STUB_STATUS_FILE: process.env.AC_E2E_STATUS_FILE as string,
  STUB_NAME_FILE: process.env.AC_E2E_NAME_FILE as string,
  STUB_SLOW_FILE: process.env.AC_E2E_SLOW_FILE as string,
  STUB_OSASCRIPT_LOG: process.env.AC_E2E_OSASCRIPT_LOG as string,
  STUB_GH_DIR: process.env.AC_E2E_GH_DIR as string,
  STUB_GH_LOG: process.env.AC_E2E_GH_LOG as string,
  STUB_UUID_FILE: process.env.AC_E2E_UUID_FILE as string,
  STUB_AUTH_FILE: process.env.AC_E2E_AUTH_FILE as string,
  STUB_AUTH_LOG: process.env.AC_E2E_AUTH_LOG as string,
};

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [["list"]],
  globalTeardown: "./tests/fixtures/e2e-teardown.ts",
  // app: 従来の画面の試験 / picker: Chrome 拡張を読み込んだ別の Chrome（launchPersistentContext）で行う、部品を選ぶ試験
  projects: [
    { name: "app", testMatch: /(console|activity|chat|reservations|relay|terminal-wheel|pc-meter)\.spec\.ts/ },
    // tmux 経由の端から端までの試験（2 つ目のサーバー・試験用ソケット）。後片付けは globalTeardown
    { name: "tmux", testMatch: /tmux\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${E2E_TMUX_PORT}` } },
    { name: "picker", testMatch: /picker\.spec\.ts/ },
  ],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    browserName: "chromium",
    // 実 PTY の出力は xterm の DOM レンダラで読む
    viewport: { width: 1400, height: 800 },
  },
  webServer: [
    {
      command: "node dist-server/server/index.js",
      url: `http://127.0.0.1:${E2E_PORT}/`,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ...(process.env as Record<string, string>),
        // 拡張の合言葉とフォルダの作り直しは「AGENT_CONSOLE_PORT が無い」ときだけ行う。開発者の環境に残っていても試験に影響させない
        AGENT_CONSOLE_PORT: "",
        AGENT_CONSOLE_CONFIG: process.env.AC_E2E_CONFIG as string,
        AGENT_CONSOLE_TOKEN: E2E_TOKEN,
        ...stubEnv,
      },
    },
    {
      command: "node dist-server/server/index.js",
      url: `http://127.0.0.1:${E2E_TMUX_PORT}/`,
      reuseExistingServer: false,
      timeout: 30000,
      env: {
        ...(process.env as Record<string, string>),
        // 引き継ぎの既定の置き場（実ホーム）を使わないよう、ポートを渡して「本番ではない」扱いにする
        AGENT_CONSOLE_PORT: String(E2E_TMUX_PORT),
        AGENT_CONSOLE_CONFIG: process.env.AC_E2E_TMUX_CONFIG as string,
        AGENT_CONSOLE_TOKEN: E2E_TOKEN,
        ...stubEnv,
      },
    },
  ],
});
