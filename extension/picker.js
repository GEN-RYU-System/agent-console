// 画面の部品を選ぶ（content script。拡張のボタンを押したときに 1 回だけ差し込まれる）。
// 選んだ内容を集めて service worker に渡す。Chrome の外の世界（アプリ）へ送るのは service worker だけ。
(() => {
  if (globalThis.__acPicker) return;

  const ATTR_NAMES = ["id", "class", "role", "aria-label", "data-testid", "href", "type", "name", "alt", "placeholder"];
  const STYLE_PROPS = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "border",
    "border-radius",
    "padding",
    "margin",
    "display",
    "gap",
    "width",
    "height",
  ];
  const LIMITS = { url: 2048, title: 300, selector: 1000, attr: 200, style: 300, text: 500, html: 4000 };
  const RESULT_SHOW_MS = 1000;
  const SETTLE_MS = 80;
  const UNIT = "px";
  const HOST_TAG = "ac-picker-host";
  const STATE_ATTR = "data-ac-pick-state";
  const REPLY_TO_STATE = { sent: "sent" };
  const REPLY_TO_MESSAGE = { sent: "resultSent", forbidden: "resultForbidden", notRunning: "resultNotRunning", error: "resultError" };

  const t = (key) => chrome.i18n.getMessage(key);
  const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const cut = (s, n) => String(s ?? "").slice(0, n);

  /** id があればそこで止め、無ければ tag:nth-of-type を親へ連ねる。 */
  function selectorOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** 入力欄の値は HTML に載せない（パスワード欄の value 属性など）。 */
  function htmlOf(el) {
    const clone = el.cloneNode(true);
    const fields = [clone, ...(clone.querySelectorAll ? clone.querySelectorAll("input, textarea") : [])];
    for (const f of fields) if (f.removeAttribute && /^(input|textarea)$/i.test(f.tagName)) f.removeAttribute("value");
    return cut(clone.outerHTML, LIMITS.html);
  }

  /** 選んだ部品の内容を集める。React の部品名は取らない（本番では意味のない記号になるため）。 */
  function collect(el) {
    const rect = el.getBoundingClientRect();
    const computed = globalThis.getComputedStyle(el);
    const attrs = {};
    for (const name of ATTR_NAMES) {
      const v = el.getAttribute(name);
      if (v) attrs[name] = cut(v, LIMITS.attr);
    }
    const style = {};
    for (const prop of STYLE_PROPS) {
      let v = "";
      try {
        v = computed.getPropertyValue(prop);
      } catch {
        v = "";
      }
      if (v) style[prop] = cut(v, LIMITS.style);
    }
    return {
      url: cut(location.href, LIMITS.url),
      title: cut(document.title, LIMITS.title),
      selector: cut(selectorOf(el), LIMITS.selector),
      tag: el.tagName.toLowerCase(),
      attrs,
      text: cut(el.innerText ?? el.textContent, LIMITS.text),
      html: htmlOf(el),
      style,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      dpr: globalThis.devicePixelRatio || 1,
      vw: globalThis.innerWidth,
    };
  }

  let active = null;

  function begin(css) {
    const host = document.createElement(HOST_TAG);
    host.setAttribute(STATE_ATTR, "selecting");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.hidden = true;
    const guide = document.createElement("div");
    guide.className = "guide";
    guide.textContent = t("guideSelecting");
    root.append(style, frame, guide);
    document.documentElement.append(host);

    let busy = false;
    const inHost = (e) => e.composedPath().includes(host);
    const place = (el) => {
      const r = el.getBoundingClientRect();
      Object.assign(frame.style, { left: r.x + UNIT, top: r.y + UNIT, width: r.width + UNIT, height: r.height + UNIT });
      frame.hidden = false;
    };
    const setState = (state, messageKey) => {
      host.setAttribute(STATE_ATTR, state);
      guide.textContent = t(messageKey);
    };

    let resultTimer;
    const stop = () => {
      clearTimeout(resultTimer);
      for (const [type, handler] of listeners) document.removeEventListener(type, handler, true);
      host.remove();
      active = null;
    };

    const onMove = (e) => {
      if (!busy && !inHost(e)) place(e.target);
    };
    // ページのスクリプトが作った偽のクリック（isTrusted でないもの）では選ばない
    const onClick = async (e) => {
      if (!e.isTrusted || inHost(e)) return;
      // 送っている間の 2 回目のクリックも、ページには渡さない（押す・離すは swallow が止めている）
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return;
      busy = true;
      const target = e.target;
      setState("sending", "guideSending");
      // 撮影に枠と案内を写さない。画面が描き直されてから集めて送る
      host.style.visibility = "hidden";
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, SETTLE_MS)));
      let status = "error";
      try {
        const payload = collect(target);
        const reply = await chrome.runtime.sendMessage({ type: "pick", payload });
        status = reply && REPLY_TO_MESSAGE[reply.status] ? reply.status : "error";
      } catch {
        status = "error";
      }
      host.style.visibility = "";
      frame.hidden = true;
      setState(REPLY_TO_STATE[status] ?? "error", REPLY_TO_MESSAGE[status]);
      resultTimer = setTimeout(stop, RESULT_SHOW_MS);
    };
    // 選んでいる間は、ページがクリックの途中（押す・離す）に反応しないようにする
    const swallow = (e) => {
      if (!e.isTrusted || inHost(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        stop();
      }
    };
    const listeners = [
      ["mousemove", onMove],
      ["mousedown", swallow],
      ["mouseup", swallow],
      ["pointerdown", swallow],
      ["pointerup", swallow],
      ["click", onClick],
      ["keydown", onKey],
    ];
    for (const [type, handler] of listeners) document.addEventListener(type, handler, true);
    return { stop };
  }

  // もう一度ボタンを押したときは、やめる
  function start(css) {
    if (active) {
      active.stop();
      return;
    }
    active = begin(css);
  }

  globalThis.__acPicker = { start, collect };
})();
