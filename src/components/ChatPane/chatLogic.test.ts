import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../types";
import { CHAT_CLIENT_KEEP, isSendBlocked, isSendKey, mergeChat, queueNoticeKey, shouldStickToBottom } from "./chatLogic";

const item = (seq: number, ts: number, over: Partial<ChatItem> = {}): ChatItem => ({ seq, ts, role: "user", text: `m${seq}`, ...over });

describe("L-b shouldStickToBottom（一番下まで動かすかの判定）", () => {
  it("一番下にいる（残りが 0）ときは動かす", () => {
    expect(shouldStickToBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });
  it("一番下から少しだけ（許容の範囲）離れていても動かす。大きく離れて上を読んでいるときは動かさない", () => {
    expect(shouldStickToBottom({ scrollTop: 590, clientHeight: 400, scrollHeight: 1000 }, 24)).toBe(true);
    expect(shouldStickToBottom({ scrollTop: 575, clientHeight: 400, scrollHeight: 1000 }, 24)).toBe(false);
    expect(shouldStickToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
  it("中身が表示の高さより短いとき（スクロールなし）は動かす", () => {
    expect(shouldStickToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });
});

describe("mergeChat", () => {
  it("続きを足す。seq が同じものは二重にしない。ts の順（同じ ts は seq の順）に並べる", () => {
    const merged = mergeChat([item(1, 10), item(2, 20)], [item(2, 20), item(3, 15)], false);
    expect(merged.map((i) => i.seq)).toEqual([1, 3, 2]);
  });
  it("reset のときは、これまでのものを捨てて、来たものだけにする", () => {
    expect(mergeChat([item(1, 10), item(2, 20)], [item(1, 5)], true).map((i) => i.seq)).toEqual([1]);
  });
  it("多すぎるときは古いものから落とす", () => {
    const many = Array.from({ length: CHAT_CLIENT_KEEP + 5 }, (_, i) => item(i + 1, i + 1));
    const merged = mergeChat([], many, false);
    expect(merged).toHaveLength(CHAT_CLIENT_KEEP);
    expect(merged[0].seq).toBe(6);
  });
  it("元の配列を変えない", () => {
    const prev = [item(1, 1)];
    mergeChat(prev, [item(2, 2)], false);
    expect(prev).toHaveLength(1);
  });
});

describe("isSendBlocked / queueNoticeKey（K8）", () => {
  it("送れない（予約も作れない）のは停止中だけ", () => {
    expect(isSendBlocked("stopped")).toBe(true);
    for (const state of ["working", "waiting", "idle", "no-claude", "unknown"] as const) expect(isSendBlocked(state)).toBe(false);
  });
  it("すぐ届く状態（canInput）なら案内は無い", () => {
    expect(queueNoticeKey("idle", true)).toBeNull();
    expect(queueNoticeKey("no-claude", true)).toBeNull();
  });
  it("すぐ届かない状態ごとに、案内の文言のキーを返す。想定外の状態は other", () => {
    expect(queueNoticeKey("working", false)).toBe("ac.chat.queue.notice.working");
    expect(queueNoticeKey("waiting", false)).toBe("ac.chat.waitingInTerminal");
    expect(queueNoticeKey("stopped", false)).toBe("ac.chat.blocked.stopped");
    expect(queueNoticeKey("unknown", false)).toBe("ac.chat.queue.notice.unknown");
    expect(queueNoticeKey("idle", false)).toBe("ac.chat.queue.notice.other");
  });
});

describe("K5 isSendKey（Enter で送り、Shift+Enter で改行。変換中は送らない）", () => {
  const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }>) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...over });
  it("Enter だけが送る", () => {
    expect(isSendKey(key({}))).toBe(true);
    expect(isSendKey(key({ key: "a" }))).toBe(false);
  });
  it("Shift+Enter は送らない（改行）", () => {
    expect(isSendKey(key({ shiftKey: true }))).toBe(false);
  });
  it("日本語の変換中（isComposing、または keyCode 229）の Enter では送らない", () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false);
    expect(isSendKey(key({ keyCode: 229 }))).toBe(false);
  });
});
