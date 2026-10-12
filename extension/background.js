// 拡張の service worker。ボタンで部品選びを始め、選ばれた部品を切り抜いてアプリ（127.0.0.1）へ送る。
// config.js は、アプリが拡張のフォルダを作るときに書く（ポートと合言葉）。正本は dataDir の picker-token。
importScripts("config.js");

const PICKS_URL = `http://127.0.0.1:${self.AC_PICKER.port}/api/picks`;
const TOKEN_HEADER = "x-ac-picker-token";
// アプリの受け取り口の本文の上限（2MiB）に base64 で収まる大きさ
const IMAGE_MAX_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 200;
const CHUNK = 0x8000;

async function readOwnText(file) {
  const res = await fetch(chrome.runtime.getURL(file));
  return res.text();
}

// activeTab の権限は、利用者がボタンを押したそのタブにだけ付く。入れるのは最上位のフレームだけ
async function start(tab) {
  try {
    const css = `${await readOwnText("picker-tokens.css")}\n${await readOwnText("picker.css")}`;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (c) => globalThis.__acPicker.start(c), args: [css] });
  } catch {
    // chrome:// など、入れられないページ
    await chrome.action.setBadgeText({ tabId: tab.id, text: chrome.i18n.getMessage("badgeError") });
  }
}
chrome.action.onClicked.addListener(start);

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** 見えている範囲を撮って、部品の位置で切り抜く。取れなければ理由を返す（部品は画像なしで送る）。 */
async function cropImage(tab, rect, vw) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = bmp.width / vw;
    const x = Math.max(0, Math.round(rect.x * scale));
    const y = Math.max(0, Math.round(rect.y * scale));
    const w = Math.min(bmp.width - x, Math.round(rect.w * scale));
    const h = Math.min(bmp.height - y, Math.round(rect.h * scale));
    if (w < 1 || h < 1) return { imageError: "the part is outside the visible area" };
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, x, y, w, h, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (blob.size > IMAGE_MAX_BYTES) return { imageError: "image is too large" };
    return { imageBase64: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  } catch (err) {
    return { imageError: String(err).slice(0, MAX_ERROR_CHARS) };
  }
}

/** 応答は sent / forbidden / notRunning / error のどれか。画面に出す文は content script が _locales から取る。 */
async function submit(tab, payload) {
  const image = await cropImage(tab, payload.rect, payload.vw);
  let res;
  try {
    res = await fetch(PICKS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: self.AC_PICKER.token },
      body: JSON.stringify({ ...payload, ...image }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return { status: "notRunning" };
  }
  if (res.status === 201) return { status: "sent" };
  return { status: res.status === 403 ? "forbidden" : "error" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pick" || !sender.tab) return false;
  submit(sender.tab, msg.payload).then(sendResponse, () => sendResponse({ status: "error" }));
  return true;
});
