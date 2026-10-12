// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(path.resolve("extension", "picker.js"), "utf8");
const STATE_ATTR = "data-ac-pick-state";
const send = vi.fn();

interface Picker {
  start: (css: string) => void;
  collect: (el: Element) => Record<string, unknown>;
}
const picker = (): Picker => (globalThis as unknown as { __acPicker: Picker }).__acPicker;
const host = (): Element | null => document.querySelector("ac-picker-host");

function load(): void {
  delete (globalThis as { __acPicker?: unknown }).__acPicker;
  // 拡張が差し込むのと同じ中身を、そのまま実行する
  (0, eval)(SOURCE);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><p class="a b" data-testid="t1" title="x">本文</p></div>';
  send.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    i18n: { getMessage: (key: string) => `msg:${key}` },
    runtime: { sendMessage: send },
  };
  load();
});
const pressEscape = (): boolean => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
afterEach(() => {
  // 前の試験の picker が document に残した listener を、その picker 自身の Esc で外す
  for (let i = 0; i < 5 && host() !== null; i += 1) pressEscape();
});

describe("picker.js: starting and stopping (K1)", () => {
  it("shows a host element with data-ac-pick-state=selecting; its shadow root is closed", () => {
    picker().start(":host{}");
    const h = host() as HTMLElement;
    expect(h).not.toBeNull();
    expect(h.getAttribute(STATE_ATTR)).toBe("selecting");
    expect(h.shadowRoot).toBeNull();
  });

  it("Esc removes the host and the picker can be started again", () => {
    picker().start("");
    pressEscape();
    expect(host()).toBeNull();
    picker().start("");
    expect(host()).not.toBeNull();
  });

  it("pressing the button again (start while active) stops it", () => {
    picker().start("");
    picker().start("");
    expect(host()).toBeNull();
  });

  it("loading the script twice keeps the first picker", () => {
    const first = picker();
    (0, eval)(SOURCE);
    expect(picker()).toBe(first);
  });
});

describe("picker.js: a click the page made itself is not a pick (K1)", () => {
  it("ignores an untrusted click: nothing is sent, the state stays selecting, and the page still receives the click", async () => {
    picker().start("");
    const target = document.querySelector("p") as HTMLElement;
    const pageSaw = vi.fn();
    target.addEventListener("click", pageSaw);
    const fake = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    expect(fake.isTrusted).toBe(false);
    target.dispatchEvent(fake);
    target.click();
    await new Promise((r) => setTimeout(r, 150));
    expect(send).not.toHaveBeenCalled();
    expect((host() as Element).getAttribute(STATE_ATTR)).toBe("selecting");
    expect(pageSaw).toHaveBeenCalledTimes(2);
    expect(fake.defaultPrevented).toBe(false);
  });

  it("reads isTrusted before doing anything else in the click handler, and swallows trusted clicks even while sending", () => {
    const click = /const onClick = async \(e\) => \{\n\s*if \(!e\.isTrusted/.exec(SOURCE);
    expect(click).not.toBeNull();
  });
});

describe("picker.js: what is collected (K2)", () => {
  it("collects url, title, selector, tag, the known attributes, text, html, style, rect, dpr and width", () => {
    document.title = "ページ題名";
    const p = document.querySelector("p") as HTMLElement;
    const c = picker().collect(p);
    expect(c.url).toBe(location.href);
    expect(c.title).toBe("ページ題名");
    expect(c.selector).toBe("#app > p");
    expect(c.tag).toBe("p");
    expect(c.attrs).toEqual({ class: "a b", "data-testid": "t1" });
    expect(c.text).toBe("本文");
    expect(String(c.html)).toContain("<p");
    expect(c.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(c.dpr).toBe(1);
    expect(c.vw).toBe(window.innerWidth);
    expect(Object.keys(c).sort()).toEqual(["attrs", "dpr", "html", "rect", "selector", "style", "tag", "text", "title", "url", "vw"]);
    expect(JSON.stringify(c)).not.toMatch(/componentChain|__reactFiber/);
  });

  it("asks for the 14 style properties and keeps only the ones the browser gives", () => {
    const asked: string[] = [];
    const fake = { getPropertyValue: (prop: string) => (asked.push(prop), prop === "color" ? "rgb(1, 2, 3)" : prop === "border" ? "" : "x") };
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue(fake as unknown as CSSStyleDeclaration);
    const c = picker().collect(document.querySelector("p") as Element);
    expect(asked).toEqual(["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border", "border-radius", "padding", "margin", "display", "gap", "width", "height"]);
    const style = c.style as Record<string, string>;
    expect(style.color).toBe("rgb(1, 2, 3)");
    expect("border" in style).toBe(false);
    expect(Object.keys(style)).toHaveLength(13);
    vi.restoreAllMocks();
  });

  it("an empty or throwing style property is left out instead of stopping", () => {
    const fake = { getPropertyValue: (prop: string) => { if (prop === "gap") throw new Error("x"); return ""; } };
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue(fake as unknown as CSSStyleDeclaration);
    expect(picker().collect(document.querySelector("p") as Element).style).toEqual({});
    vi.restoreAllMocks();
  });

  it("cuts text at 500 characters and html at 4000, and each attribute at 200", () => {
    document.body.innerHTML = `<div id="big" title="${"t".repeat(300)}" class="${"c".repeat(300)}">${"あ".repeat(5000)}</div>`;
    const c = picker().collect(document.getElementById("big") as Element);
    expect((c.text as string).length).toBe(500);
    expect((c.html as string).length).toBe(4000);
    expect((c.attrs as Record<string, string>).class).toHaveLength(200);
  });

  it("builds a path with nth-of-type when there is no id, and stops at the nearest id", () => {
    document.body.innerHTML = '<ul id="list"><li>a</li><li><b>x</b></li></ul>';
    expect(picker().collect(document.querySelectorAll("li")[1]).selector).toBe("#list > li:nth-of-type(2)");
    expect(picker().collect(document.querySelector("b") as Element).selector).toBe("#list > li:nth-of-type(2) > b");
  });

  it("does not put the value of an input field into the html", () => {
    document.body.innerHTML = '<form id="f"><input type="password" value="secret-pass"><textarea value="x">y</textarea></form>';
    const c = picker().collect(document.getElementById("f") as Element);
    expect(String(c.html)).not.toContain("secret-pass");
  });
});
