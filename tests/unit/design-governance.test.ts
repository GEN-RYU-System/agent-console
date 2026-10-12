import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "check-design-governance.mjs");

function makeProject(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-gov-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function run(dir: string) {
  return spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
}

describe("check-design-governance", () => {
  it("passes a clean project", () => {
    const dir = makeProject({
      "src/a.css": ".a { color: var(--text-primary); }\n",
      "src/pages/P.tsx": "export const P = () => <div>{t('x')}</div>;\n",
    });
    expect(run(dir).status).toBe(0);
  });

  it("reports color literals with file:line", () => {
    const dir = makeProject({ "src/a.css": ".a {\n  color: #fff;\n  background: rgb(0,0,0);\n}\n" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/a.css:2:");
    expect(r.stderr).toContain("src/a.css:3:");
  });

  it("reports raw form elements in pages", () => {
    const dir = makeProject({ "src/pages/P.tsx": "export const P = () => (\n  <button>x</button>\n);\n" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/pages/P.tsx:2:");
  });

  it("allows raw elements outside pages", () => {
    const dir = makeProject({ "src/components/C.tsx": "export const C = () => <button>x</button>;\n" });
    expect(run(dir).status).toBe(0);
  });

  it("reports hard-coded Japanese in TSX", () => {
    const dir = makeProject({ "src/components/C.tsx": "export const C = () => <p>保存</p>;\n" });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/components/C.tsx:1:");
  });

  it("reports a committed .sa-cache", () => {
    const dir = makeProject({ "src/a.css": "", ".sa-cache/SOURCE": "x\n" });
    execFileSync("git", ["add", "-f", ".sa-cache/SOURCE"], { cwd: dir });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(".sa-cache/SOURCE");
  });

  describe("stricter rules", () => {
    const css = (body: string) => makeProject({ "src/a.css": body });

    describe("reports CSS named colors in values but not in var names or keywords", () => {
      it("case 1", () => {
        expect(run(css(".a { color: red; }\n")).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(css(".a { border: 1px solid rebeccapurple; }\n")).status).toBe(1);
      });
      it("case 3", () => {
        expect(run(css(".a { color: var(--color-red-50); background: transparent; outline-color: currentColor; }\n")).status).toBe(0);
      });
      it("case 4", () => {
        expect(run(css(".red { margin: 0; }\n")).status).toBe(0);
      });
    });

    // 1 回の検査は node の起動を伴う。負荷時に 1 つの it が 5 秒に近づかないよう、1 件ずつ別の it にする
    it.each(["oklch(0.5 0.1 20)", "oklab(0.5 0 0)", "lab(50 0 0)", "lch(50 0 0)", "hwb(10 10% 10%)", "color(display-p3 1 0 0)"])("reports modern color function %s", (v) => {
      expect(run(css(`.a { color: ${v}; }\n`)).status, v).toBe(1);
    });

    describe("reports px/rem/em literals but allows 0, percentages, viewport units, @media and 1px borders", () => {
      it("case 1", () => {
        expect(run(css(".a { width: 18rem; }\n")).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(css(".a { padding: 4px; }\n")).status).toBe(1);
      });
      it("case 3", () => {
        expect(run(css(".a { margin: 0.5em; }\n")).status).toBe(1);
      });
      it("case 4", () => {
        expect(run(css(".a { width: calc(100% - 12px); }\n")).status).toBe(1);
      });
      it("case 5", () => {
        expect(run(css(".a { margin: 0; width: 100%; height: 100vh; }\n")).status).toBe(0);
      });
      it("case 6", () => {
        expect(run(css("@media (min-width: 800px) {\n  .a { margin: 0; }\n}\n")).status).toBe(0);
      });
      it("case 7", () => {
        expect(run(css(".a { border: 1px solid var(--border); border-left: 0; }\n")).status).toBe(0);
      });
      it("case 8", () => {
        expect(run(css(".a { margin: 1px; }\n")).status).toBe(1);
      });
      it("case 9", () => {
        expect(run(css(".a { border: 2px solid var(--border); }\n")).status).toBe(1);
      });
    });

    describe("reports numeric values in inline style objects", () => {
      const tsx = (body: string) => makeProject({ "src/components/C.tsx": `export const C = () => ${body};\n` });
      it("case 1", () => {
        expect(run(tsx("<div style={{ width: 12 }} />")).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(tsx('<div style={{ width: "10px" }} />')).status).toBe(1);
      });
      it("case 3", () => {
        expect(run(tsx("<div style={{\n  height: 3,\n}} />")).status).toBe(1);
      });
      it("case 4", () => {
        expect(run(tsx('<div style={{ width: "100%", minWidth: 0, opacity: 1 }} />')).status).toBe(0);
      });
      it("case 5", () => {
        expect(run(tsx('<div style={{ width: "var(--space-4)" }} />')).status).toBe(0);
      });
    });

    describe("reports numeric fontSize / lineHeight / letterSpacing literals in TS/TSX", () => {
      const ts = (body: string) => makeProject({ "src/components/t.ts": body });
      it("case 1", () => {
        expect(run(ts("export const o = { fontSize: 13 };\n")).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(ts("export const o = { lineHeight: 1.2 };\n")).status).toBe(1);
      });
      it("case 3", () => {
        expect(run(ts("export const o = { fontSize: px };\n")).status).toBe(0);
      });
    });

    it("reports <a in pages", () => {
      expect(run(makeProject({ "src/pages/P.tsx": "export const P = () => <a href=\"x\">x</a>;\n" })).status).toBe(1);
    });
  });

  describe("font-family and the app token file", () => {
    describe("reports font-family literals outside src/tokens.app.css (CSS and TS)", () => {
      it("case 1", () => {
        expect(run(makeProject({ "src/a.css": ".a { font-family: Menlo, monospace; }\n" })).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(makeProject({ "src/components/t.ts": 'export const o = { fontFamily: "monospace" };\n' })).status).toBe(1);
      });
    });

    describe("allows var(), inherit and the like for font-family", () => {
      it("case 1", () => {
        expect(run(makeProject({ "src/a.css": ".a { font-family: var(--ac-font-mono); }\n.b { font-family: inherit; }\n" })).status).toBe(0);
      });
      it("case 2", () => {
        expect(run(makeProject({ "src/components/t.ts": "export const o = { fontFamily: mono };\n" })).status).toBe(0);
      });
    });

    it("allows font names only as --ac- custom properties in src/tokens.app.css", () => {
      expect(run(makeProject({ "src/tokens.app.css": ':root { --ac-font-mono: Menlo, "Courier New", monospace; }\n' })).status).toBe(0);
    });

    describe("reports anything else in src/tokens.app.css", () => {
      it("case 1", () => {
        expect(run(makeProject({ "src/tokens.app.css": ":root { --other: 1; }\n" })).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(makeProject({ "src/tokens.app.css": ":root { color: var(--x); }\n" })).status).toBe(1);
      });
    });
  });

  describe("values in src/tokens.app.css", () => {
    const tok = (body: string) => makeProject({ "src/tokens.app.css": `:root { ${body} }\n` });

    describe("accepts font stacks (quoted or bare names, ending with a generic family)", () => {
      it("case 1", () => {
        expect(run(tok('--ac-font-mono: Menlo, Monaco, "Courier New", monospace;')).status).toBe(0);
      });
      it("case 2", () => {
        expect(run(tok("--ac-font-mono: 'SF Mono', ui-monospace, monospace;")).status).toBe(0);
      });
    });

    describe("accepts lengths (px / rem) as --ac- values (K2)", () => {
      it("56px", () => {
        expect(run(tok("--ac-tab-h: 56px;")).status).toBe(0);
      });
      it("17px", () => {
        expect(run(tok("--ac-gap: 17px;")).status).toBe(0);
      });
      it("1.5rem", () => {
        expect(run(tok("--ac-gap: 1.5rem;")).status).toBe(0);
      });
    });

    describe("rejects color names, unitless values, calc and other values", () => {
      it("case 1", () => {
        expect(run(tok("--ac-bg: red;")).status).toBe(1);
      });
      it("case 2", () => {
        expect(run(tok("--ac-gap: calc(1px + 2px);")).status).toBe(1);
      });
      it("case 3", () => {
        expect(run(tok("--ac-gap: 0;")).status).toBe(1);
      });
      it("case 8", () => {
        expect(run(tok("--ac-gap: 56px 12px;")).status).toBe(1);
      });
      it("case 9", () => {
        expect(run(tok("--ac-gap: 56em;")).status).toBe(1);
      });
      it("case 4", () => {
        expect(run(tok("--ac-font-mono: red, monospace;")).status).toBe(1);
      });
      it("case 5", () => {
        expect(run(tok("--ac-font-mono: Menlo, Monaco;")).status).toBe(1);
      });
      it("case 6", () => {
        expect(run(tok("--ac-font-mono: 12px, monospace;")).status).toBe(1);
      });
      it("case 7", () => {
        expect(run(tok("--ac-font-mono: var(--x);")).status).toBe(1);
      });
    });
  });
  describe("extension/ is checked too (K9)", () => {
    const ext = (files: Record<string, string>) => makeProject({ "src/a.css": "", ...files });

    it("passes a picker that only uses var(--pick-…) and computes geometry from the page", () => {
      const dir = ext({
        "extension/picker.css": ".frame { position: fixed; border: var(--pick-frame-width) solid var(--pick-frame-color); padding: var(--pick-space); margin: 0; }\n",
        "extension/picker.js": "const UNIT = 'px';\nel.style.left = r.x + UNIT;\nel.style.width = `${r.width}px`;\n",
        "extension/_locales/ja/messages.json": '{ "guide": { "message": "クリックで選ぶ" } }\n',
      });
      expect(run(dir).status).toBe(0);
    });

    it("reports a color literal in extension JS with file:line", () => {
      const dir = ext({ "extension/picker.js": "const a = 1;\nframe.style.border = '2px solid #e11d48';\n" });
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("extension/picker.js:2:");
    });

    it.each(["rgba(0, 0, 0, .5)", "hsl(10 10% 10%)", "14px", "0.5rem", "12px"])("reports %s written in extension JS", (v) => {
      expect(run(ext({ "extension/picker.js": `el.style.x = "${v}";\n` })).status, v).toBe(1);
    });

    it("reports a direct value in extension CSS", () => {
      expect(run(ext({ "extension/picker.css": ".a { color: red; }\n" })).status).toBe(1);
      expect(run(ext({ "extension/picker.css": ".a { padding: 8px; }\n" })).status).toBe(1);
      expect(run(ext({ "extension/picker.css": ".a { background: #fff; }\n" })).status).toBe(1);
    });

    it("exempts only the generated picker-tokens.css", () => {
      const generated = ":host {\n  --pick-frame-color: #1e3a8a;\n  --pick-space: 8px;\n}\n";
      expect(run(ext({ "extension/picker-tokens.css": generated })).status).toBe(0);
      expect(run(ext({ "extension/other.css": generated })).status).toBe(1);
    });

    it("reports hard-coded Japanese in extension JS but allows it in comments", () => {
      const bad = run(ext({ "extension/picker.js": "const m = 'クリックで選ぶ';\n" }));
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("extension/picker.js:1:");
      expect(run(ext({ "extension/picker.js": "// 案内の文は _locales に置く\nconst m = chrome.i18n.getMessage('guide');\n" })).status).toBe(0);
    });
  });
});
