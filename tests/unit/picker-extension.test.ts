import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXTENSION_DIR_NAME,
  PICKER_TOKEN_FILE,
  ensurePickerToken,
  extensionIdFromKey,
  isPickerSetupEnabled,
  rebuildExtensionFolder,
  setupPicker,
} from "../../server/picker-extension.ts";

const SOURCE = path.resolve("extension");
const sourceManifest = JSON.parse(readFileSync(path.join(SOURCE, "manifest.json"), "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "ac-pe-"));
/** extension/ の写しに、ビルドで作る picker-tokens.css を足した置き場。 */
function sourceCopy(withTokens = true): string {
  const dir = path.join(tmp(), "extension");
  cpSync(SOURCE, dir, { recursive: true, filter: (src) => !src.endsWith("picker-tokens.css") });
  if (withTokens) writeFileSync(path.join(dir, "picker-tokens.css"), ":host{--pick-frame-color:#123456}\n");
  return dir;
}

describe("extensionIdFromKey (K6)", () => {
  it("derives the Chrome extension id from the manifest key (a-p alphabet, 32 chars) and it is stable", () => {
    const id = extensionIdFromKey(sourceManifest.key as string);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).toBe("cifnedlggndeehoejlfapbhepekgikao");
  });

  it("refuses a key that is not base64", () => {
    expect(() => extensionIdFromKey("")).toThrow();
  });
});

describe("the source manifest", () => {
  it("is MV3 with only activeTab and scripting, default_locale ja, no host_permissions of its own, and the same version as the app", () => {
    expect(sourceManifest.manifest_version).toBe(3);
    expect(sourceManifest.permissions).toEqual(["activeTab", "scripting"]);
    expect(sourceManifest.default_locale).toBe("ja");
    expect(sourceManifest.host_permissions).toBeUndefined();
    expect(sourceManifest.version).toBe(pkg.version);
  });

  it("every __MSG_ name it uses exists in _locales/ja/messages.json", () => {
    const messages = JSON.parse(readFileSync(path.join(SOURCE, "_locales", "ja", "messages.json"), "utf8")) as Record<string, { message: string }>;
    for (const m of JSON.stringify(sourceManifest).matchAll(/__MSG_(\w+)__/g)) expect(messages[m[1]]?.message, m[1]).toBeTruthy();
  });

  it("contains no private key material", () => {
    const files = readdirSync(SOURCE, { recursive: true }) as string[];
    for (const f of files) expect(f, f).not.toMatch(/\.pem$|private/i);
    expect(JSON.stringify(sourceManifest)).not.toMatch(/PRIVATE KEY/);
  });
});

describe("isPickerSetupEnabled (K10)", () => {
  it("is on only when AGENT_CONSOLE_PORT is unset or empty", () => {
    expect(isPickerSetupEnabled({})).toBe(true);
    expect(isPickerSetupEnabled({ AGENT_CONSOLE_PORT: "" })).toBe(true);
    expect(isPickerSetupEnabled({ AGENT_CONSOLE_PORT: "4320" })).toBe(false);
  });
});

describe("ensurePickerToken (§3-4)", () => {
  it("creates 32 random bytes as 64 hex digits with mode 600 in a 700 directory, and reuses it afterwards", async () => {
    const dataDir = path.join(tmp(), "data");
    const t1 = await ensurePickerToken(dataDir);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path.join(dataDir, PICKER_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(await ensurePickerToken(dataDir)).toBe(t1);
    expect(readFileSync(path.join(dataDir, PICKER_TOKEN_FILE), "utf8").trim()).toBe(t1);
  });

  it("makes a new one after the file was deleted (the documented way to change it)", async () => {
    const dataDir = path.join(tmp(), "data");
    const t1 = await ensurePickerToken(dataDir);
    writeFileSync(path.join(dataDir, PICKER_TOKEN_FILE), "");
    const t2 = await ensurePickerToken(dataDir);
    expect(t2).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).not.toBe(t1);
  });
});

describe("rebuildExtensionFolder (K10)", () => {
  it("builds dataDir/chrome-extension from the source: host permission for the port only, config.js with the port and token (600), the generated css and the locale", async () => {
    const dataDir = path.join(tmp(), "data");
    const token = "ab".repeat(32);
    const out = await rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token });
    expect(out).toBe(path.join(dataDir, EXTENSION_DIR_NAME));
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1:4319/*"]);
    expect(manifest.key).toBe(sourceManifest.key);
    expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
    const config = readFileSync(path.join(out, "config.js"), "utf8");
    expect(config).toContain("4319");
    expect(config).toContain(token);
    expect(statSync(path.join(out, "config.js")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(out, "picker-tokens.css"))).toBe(true);
    expect(existsSync(path.join(out, "_locales", "ja", "messages.json"))).toBe(true);
    for (const f of ["background.js", "picker.js", "picker.css"]) expect(existsSync(path.join(out, f)), f).toBe(true);
  });

  it("K6/§3-7: the folder the PO loads has no test hook and no extra host permission", async () => {
    const dataDir = path.join(tmp(), "data");
    const out = await rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token: "ab".repeat(32) });
    expect(readFileSync(path.join(out, "background.js"), "utf8")).not.toContain("__acStartForTest");
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as { host_permissions: string[] };
    expect(manifest.host_permissions).toHaveLength(1);
  });

  it("replaces an existing folder in place (same path) and leaves no .new or .old behind", async () => {
    const dataDir = path.join(tmp(), "data");
    const source = sourceCopy();
    const out = await rebuildExtensionFolder({ sourceDir: source, dataDir, port: 4319, token: "11".repeat(32) });
    writeFileSync(path.join(out, "stale.txt"), "old version file");
    const again = await rebuildExtensionFolder({ sourceDir: source, dataDir, port: 4319, token: "22".repeat(32) });
    expect(again).toBe(out);
    expect(existsSync(path.join(out, "stale.txt"))).toBe(false);
    expect(readFileSync(path.join(out, "config.js"), "utf8")).toContain("22".repeat(32));
    expect(readdirSync(dataDir).sort()).toEqual([EXTENSION_DIR_NAME]);
  });

  it("MEDIUM-C: first removes leftovers of an interrupted run (.new and .old, even when they hold files), and touches nothing else in dataDir", async () => {
    const dataDir = path.join(tmp(), "data");
    mkdirSync(path.join(dataDir, `${EXTENSION_DIR_NAME}.new`, "sub"), { recursive: true });
    writeFileSync(path.join(dataDir, `${EXTENSION_DIR_NAME}.new`, "sub", "x"), "x");
    mkdirSync(path.join(dataDir, `${EXTENSION_DIR_NAME}.old`), { recursive: true });
    writeFileSync(path.join(dataDir, `${EXTENSION_DIR_NAME}.old`, "y"), "y");
    mkdirSync(path.join(dataDir, `${EXTENSION_DIR_NAME}.other`), { recursive: true });
    writeFileSync(path.join(dataDir, "quick-prompts.json"), "keep");
    await rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token: "ab".repeat(32) });
    expect(readdirSync(dataDir).sort()).toEqual([EXTENSION_DIR_NAME, `${EXTENSION_DIR_NAME}.other`, "quick-prompts.json"].sort());
    expect(readFileSync(path.join(dataDir, "quick-prompts.json"), "utf8")).toBe("keep");
  });

  it("an existing folder with files in it can be replaced (rename of a non-empty directory would fail, so it moves to .old first)", async () => {
    const dataDir = path.join(tmp(), "data");
    mkdirSync(path.join(dataDir, EXTENSION_DIR_NAME), { recursive: true });
    writeFileSync(path.join(dataDir, EXTENSION_DIR_NAME, "keep-until-swap.txt"), "x");
    await rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token: "ab".repeat(32) });
    expect(existsSync(path.join(dataDir, EXTENSION_DIR_NAME, "keep-until-swap.txt"))).toBe(false);
    expect(existsSync(path.join(dataDir, EXTENSION_DIR_NAME, "manifest.json"))).toBe(true);
  });

  it("fails with a clear message, leaving the current folder as it was, when the generated css is missing", async () => {
    const dataDir = path.join(tmp(), "data");
    const good = await rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token: "ab".repeat(32) });
    await expect(rebuildExtensionFolder({ sourceDir: sourceCopy(false), dataDir, port: 4319, token: "cd".repeat(32) })).rejects.toThrow(/picker-tokens\.css/);
    expect(readFileSync(path.join(good, "config.js"), "utf8")).toContain("ab".repeat(32));
    expect(readdirSync(dataDir)).toEqual([EXTENSION_DIR_NAME]);
  });

  it("refuses a bad port or a token that is not 64 hex digits", async () => {
    const dataDir = path.join(tmp(), "data");
    await expect(rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 0, token: "ab".repeat(32) })).rejects.toThrow(/port/);
    await expect(rebuildExtensionFolder({ sourceDir: sourceCopy(), dataDir, port: 4319, token: 'x");evil(' })).rejects.toThrow(/token/);
  });
});

describe("setupPicker (K10)", () => {
  it("production start (no AGENT_CONSOLE_PORT): makes the token and the folder, and returns the origin and token for the endpoint", async () => {
    const dataDir = path.join(tmp(), "data");
    const access = await setupPicker({ env: {}, dataDir, port: 4319, sourceDir: sourceCopy() });
    expect(access.extensionOrigin).toBe("chrome-extension://cifnedlggndeehoejlfapbhepekgikao");
    expect(access.token).toMatch(/^[0-9a-f]{64}$/);
    expect(access.extensionDir).toBe(path.join(dataDir, EXTENSION_DIR_NAME));
    expect(existsSync(path.join(access.extensionDir, "manifest.json"))).toBe(true);
    expect(readFileSync(path.join(access.extensionDir, "config.js"), "utf8")).toContain(access.token as string);
  });

  it("with AGENT_CONSOLE_PORT set (self-check, tests): creates nothing in dataDir and accepts no pick (token null)", async () => {
    const dataDir = path.join(tmp(), "data");
    const access = await setupPicker({ env: { AGENT_CONSOLE_PORT: "4320" }, dataDir, port: 4320, sourceDir: sourceCopy() });
    expect(access.token).toBeNull();
    expect(access.extensionDir).toBe(path.join(dataDir, EXTENSION_DIR_NAME));
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does not stop the server when the folder cannot be built: logs it and accepts no pick", async () => {
    const dataDir = path.join(tmp(), "data");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const access = await setupPicker({ env: {}, dataDir, port: 4319, sourceDir: sourceCopy(false) });
    expect(access.token).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
