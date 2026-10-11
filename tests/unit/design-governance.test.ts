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

    it("reports CSS named colors in values but not in var names or keywords", () => {
      expect(run(css(".a { color: red; }\n")).status).toBe(1);
      expect(run(css(".a { border: 1px solid rebeccapurple; }\n")).status).toBe(1);
      expect(run(css(".a { color: var(--color-red-50); background: transparent; outline-color: currentColor; }\n")).status).toBe(0);
      expect(run(css(".red { margin: 0; }\n")).status).toBe(0);
    });

    it("reports modern color functions", () => {
      for (const v of ["oklch(0.5 0.1 20)", "oklab(0.5 0 0)", "lab(50 0 0)", "lch(50 0 0)", "hwb(10 10% 10%)", "color(display-p3 1 0 0)"]) {
        const r = run(css(`.a { color: ${v}; }\n`));
        expect(r.status, v).toBe(1);
      }
    });

    it("reports px/rem/em literals but allows 0, percentages, viewport units, @media and 1px borders", () => {
      expect(run(css(".a { width: 18rem; }\n")).status).toBe(1);
      expect(run(css(".a { padding: 4px; }\n")).status).toBe(1);
      expect(run(css(".a { margin: 0.5em; }\n")).status).toBe(1);
      expect(run(css(".a { width: calc(100% - 12px); }\n")).status).toBe(1);
      expect(run(css(".a { margin: 0; width: 100%; height: 100vh; }\n")).status).toBe(0);
      expect(run(css("@media (min-width: 800px) {\n  .a { margin: 0; }\n}\n")).status).toBe(0);
      expect(run(css(".a { border: 1px solid var(--border); border-left: 0; }\n")).status).toBe(0);
      expect(run(css(".a { margin: 1px; }\n")).status).toBe(1);
      expect(run(css(".a { border: 2px solid var(--border); }\n")).status).toBe(1);
    });

    it("reports numeric values in inline style objects", () => {
      const tsx = (body: string) => makeProject({ "src/components/C.tsx": `export const C = () => ${body};\n` });
      expect(run(tsx("<div style={{ width: 12 }} />")).status).toBe(1);
      expect(run(tsx('<div style={{ width: "10px" }} />')).status).toBe(1);
      expect(run(tsx("<div style={{\n  height: 3,\n}} />")).status).toBe(1);
      expect(run(tsx('<div style={{ width: "100%", minWidth: 0, opacity: 1 }} />')).status).toBe(0);
      expect(run(tsx('<div style={{ width: "var(--space-4)" }} />')).status).toBe(0);
    });

    it("reports numeric fontSize / lineHeight / letterSpacing literals in TS/TSX", () => {
      const ts = (body: string) => makeProject({ "src/components/t.ts": body });
      expect(run(ts("export const o = { fontSize: 13 };\n")).status).toBe(1);
      expect(run(ts("export const o = { lineHeight: 1.2 };\n")).status).toBe(1);
      expect(run(ts("export const o = { fontSize: px };\n")).status).toBe(0);
    });

    it("reports <a in pages", () => {
      expect(run(makeProject({ "src/pages/P.tsx": "export const P = () => <a href=\"x\">x</a>;\n" })).status).toBe(1);
    });
  });
});
