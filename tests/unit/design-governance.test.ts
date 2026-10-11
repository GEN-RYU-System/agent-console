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
});
