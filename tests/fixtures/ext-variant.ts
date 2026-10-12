import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 設計 §3-7: e2e では activeTab が付かないので、extension/ から試験用の変種を作る。足すのは、(1) host_permissions (2) service worker の試験用の起点。
 * 設計からの逸脱: (1) は試験のポートだけでは足りない。chrome.tabs.captureVisibleTab は「<all_urls> か activeTab のどちらか」を要求する
 * （実測: Either the '<all_urls>' or 'activeTab' permission is required.）。そこで変種には <all_urls> も足す。変種は tests/ の一時フォルダにだけ作る。
 */

const ALL_URLS = "<all_urls>";
export const TEST_HOOK = "self.__acStartForTest = start;";

export interface VariantOptions {
  sourceDir: string;
  destDir: string;
  /** アプリの待ち受けポート（拡張が部品を送る先） */
  appPort: number;
  /** 合言葉（アプリが dataDir/picker-token に作ったもの） */
  token: string;
  /** 部品を選ぶページのポート（アプリ自身と、別のサイト役） */
  pagePorts: readonly number[];
}

/** 変種は tests/ の一時フォルダにだけ作る。PO が読み込む dataDir/chrome-extension には、どちらも入れない。 */
export function buildExtensionVariant(opts: VariantOptions): void {
  if (!existsSync(path.join(opts.sourceDir, "picker-tokens.css"))) throw new Error("extension/picker-tokens.css がありません。先に npm run build を実行してください");
  mkdirSync(opts.destDir, { recursive: true });
  for (const name of ["background.js", "picker.js", "picker.css", "picker-tokens.css"]) cpSync(path.join(opts.sourceDir, name), path.join(opts.destDir, name));
  cpSync(path.join(opts.sourceDir, "_locales"), path.join(opts.destDir, "_locales"), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(opts.sourceDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const hosts = [...[opts.appPort, ...opts.pagePorts].map((p) => `http://127.0.0.1:${p}/*`), ALL_URLS];
  writeFileSync(path.join(opts.destDir, "manifest.json"), JSON.stringify({ ...manifest, host_permissions: [...new Set(hosts)] }, null, 2));
  const background = readFileSync(path.join(opts.sourceDir, "background.js"), "utf8");
  writeFileSync(path.join(opts.destDir, "background.js"), `${background}\n${TEST_HOOK}\n`);
  const config = path.join(opts.destDir, "config.js");
  writeFileSync(config, `self.AC_PICKER = ${JSON.stringify({ port: opts.appPort, token: opts.token })};\n`);
  chmodSync(config, 0o600);
}
