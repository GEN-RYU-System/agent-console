import { defineConfig } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN, prepareE2eEnv } from "./tests/fixtures/e2e-env";

prepareE2eEnv();

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [["list"]],
  // app: 従来の画面の試験 / picker: Chrome 拡張を読み込んだ別の Chrome（launchPersistentContext）で行う、部品を選ぶ試験
  projects: [
    { name: "app", testMatch: /console\.spec\.ts/ },
    { name: "picker", testMatch: /picker\.spec\.ts/ },
  ],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    browserName: "chromium",
    // 実 PTY の出力は xterm の DOM レンダラで読む
    viewport: { width: 1400, height: 800 },
  },
  webServer: {
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
      STUB_STATUS_FILE: process.env.AC_E2E_STATUS_FILE as string,
      STUB_NAME_FILE: process.env.AC_E2E_NAME_FILE as string,
      STUB_SLOW_FILE: process.env.AC_E2E_SLOW_FILE as string,
      STUB_OSASCRIPT_LOG: process.env.AC_E2E_OSASCRIPT_LOG as string,
      STUB_GH_DIR: process.env.AC_E2E_GH_DIR as string,
      STUB_GH_LOG: process.env.AC_E2E_GH_LOG as string,
    },
  },
});
