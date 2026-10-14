// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";

afterEach(cleanup);

function html(markdown: string): HTMLElement {
  const { container } = render(<MarkdownView text={markdown} />);
  return container;
}

describe("K4 Markdown の描画", () => {
  it("見出し・箇条書き・番号つきの一覧・太字・コード（行内とブロック）を描画する", () => {
    const c = html("# 大見出し\n\n## 小見出し\n\n- りんご\n- みかん\n\n1. 一\n2. 二\n\n**太字** と `code` です。\n\n```ts\nconst a = 1;\n```\n");
    expect(c.querySelector("h1")?.textContent).toBe("大見出し");
    expect(c.querySelector("h2")?.textContent).toBe("小見出し");
    expect([...c.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["りんご", "みかん"]);
    expect([...c.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual(["一", "二"]);
    expect(c.querySelector("strong")?.textContent).toBe("太字");
    expect(c.querySelector("p code")?.textContent).toBe("code");
    expect(c.querySelector("pre code")?.textContent).toContain("const a = 1;");
  });

  it("表（GFM）を描画する", () => {
    const c = html("| 名前 | 値 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n");
    expect([...c.querySelectorAll("th")].map((e) => e.textContent)).toEqual(["名前", "値"]);
    expect([...c.querySelectorAll("tbody td")].map((e) => e.textContent)).toEqual(["a", "1", "b", "2"]);
  });

  it("HTML は描画しない（script・イベント属性つきの要素・iframe・style は要素にならない）", () => {
    const c = html('前\n\n<script>window.__pwned = 1</script>\n\n<img src="x" onerror="window.__pwned = 2">\n\n<iframe src="https://example.invalid"></iframe>\n\n<div onclick="window.__pwned = 3">div</div>\n\n<style>p{color:red}</style>\n\n後');
    expect(c.querySelector("script, img, iframe, style, div[onclick]")).toBeNull();
    expect(c.innerHTML).not.toContain("onerror");
    expect(c.innerHTML).not.toContain("onclick");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(c.textContent).toContain("前");
    expect(c.textContent).toContain("後");
  });

  it("javascript: のリンクは href にならない（リンクの文字は残る）。data: も同じ", () => {
    const c = html("[押す](javascript:alert(1)) と [別](JaVaScRiPt:alert(2)) と [d](data:text/html;base64,PHNjcmlwdD4=)");
    for (const a of c.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*(javascript|data):/i);
    }
    expect(c.textContent).toContain("押す");
    expect(c.textContent).toContain("別");
  });

  it("リンクは別のタブで開く（target=_blank・rel に noopener noreferrer）。http・https・mailto は href になる", () => {
    const c = html("[公式](https://example.com/a?b=1) と [メール](mailto:a@example.com) と [相対](/x)");
    const links = [...c.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1", "mailto:a@example.com", "/x"]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("画像（![alt](url)）は <img> にしない（外へ取りに行かない）。代わりの文字（alt）を出す", () => {
    const c = html("![図の説明](https://example.com/p.png)");
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("図の説明");
  });

  it("本文は元の文字列を書き換えない（空の本文でもエラーにならない）", () => {
    expect(html("").textContent).toBe("");
  });
});

describe("K11 チャットの見た目が変わらない（代表入力の innerHTML を固定値と比べる）", () => {
  it("見出し・表・箇条書き・コード・リンク・画像", () => {
    const md = "# 見出し\n\n## 小見出し\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- 一\n- 二\n\n1. い\n\n`x` と\n\n```ts\nconst a = 1;\n```\n\n[公式](https://example.com) と [相対](/x) と [js](javascript:alert(1))\n\n![図](https://example.com/p.png)\n";
    expect(html(md).innerHTML).toBe(
      "<div class=\"ac-md\"><h1>見出し</h1>\n<h2>小見出し</h2>\n<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n<ul>\n<li>一</li>\n<li>二</li>\n</ul>\n<ol>\n<li>い</li>\n</ol>\n<p><code>x</code> と</p>\n<pre><code class=\"language-ts\">const a = 1;\n</code></pre>\n<p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">公式</a> と <a href=\"/x\" target=\"_blank\" rel=\"noopener noreferrer\">相対</a> と <span>js</span></p>\n<p><span>図</span></p></div>",
    );
  });
});
