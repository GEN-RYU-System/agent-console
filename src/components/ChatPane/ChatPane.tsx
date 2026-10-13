import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { TextareaControl } from "@sa/components/Textarea";
import { ApiError, cancelChatQueue, fetchChat, queueChat } from "../../api";
import type { ChatItem, ChatQueueItem, QuickPrompt, SessionState } from "../../types";
import { QuickPromptBar } from "../QuickPrompts/QuickPromptBar";
import { ChatMarkdown } from "./ChatMarkdown";
import { isSendBlocked, isSendKey, mergeChat, queueNoticeKey, shouldStickToBottom } from "./chatLogic";
import "./ChatPane.css";

/** サーバーの CHAT_QUEUE_MAX と同じ値（超えたときの案内に出す） */
const CHAT_QUEUE_MAX = 10;

interface Props {
  /** 選んでいるセッション。別のセッションへ切り替えたら、呼び出し側が key を変えて作り直す（会話・入力欄を持ち越さない） */
  sessionId: string | null;
  /** このタブが開いているか（閉じている間は会話を取りに行かない。DOM には残す） */
  active: boolean;
  /** セッションの様子の記録の版。進んだら、続きの会話を取り直す */
  rev: number;
  state: SessionState;
  /** 今、端末へ文章を入れてよい状態か（サーバーの判定。セッション一覧と同じ） */
  canInput: boolean;
  prompts: QuickPrompt[];
  onEditPrompts: () => void;
  onPromptsChanged: () => void;
  /** 端末タブへ移る（確認の待ちのときの案内の Button） */
  onOpenTerminal: () => void;
}

type Load = "loading" | "noSession" | "ok";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 「チャット」タブ。選んだセッションの会話（hook の記録から作る）を、右にしんごさん・左に Claude の吹き出しで出し、下の入力欄から送る。
 * 「送る」は、いつでもサーバーの送信の予約に入れるだけ（手が空けばすぐ、作業中なら作業が終わってから、サーバーが端末へ書く）。
 * 会話の正本は記録のファイル、予約の正本はサーバーのメモリで、ここは写しだけ。
 */
export function ChatPane({ sessionId, active, rev, state, canInput, prompts, onEditPrompts, onPromptsChanged, onOpenTerminal }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** サーバーの送信の予約の写し（古い順） */
  const [queued, setQueued] = useState<ChatQueueItem[]>([]);
  const cursor = useRef<{ lastSeq: number; epoch: string | null }>({ lastSeq: 0, epoch: null });
  const sendingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 会話と予約を取る: 開いたとき・記録の版が進んだとき（予約の変化でも版は進む）。続きだけ（since=最後の seq、epoch つき）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    try {
      const res = await fetchChat(sessionId, cursor.current.lastSeq, cursor.current.epoch);
      if (!alive.current) return;
      setLoadFailed(false);
      setQueued(res.queued);
      if (res.status === "noSession") {
        setLoad("noSession");
        return;
      }
      cursor.current = { lastSeq: res.lastSeq, epoch: res.epoch };
      setItems((prev) => mergeChat(prev, res.items, res.reset));
      setLoad("ok");
    } catch {
      if (alive.current) setLoadFailed(true);
    }
  }, [sessionId]);
  useEffect(() => {
    if (active) void reload();
  }, [active, rev, reload]);

  // 新しいものが来たら一番下まで動かす。上を読んでいるとき（一番下から離れているとき）は動かさない
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, active, load]);
  const handleScroll = (): void => {
    const el = listRef.current;
    if (el !== null) stickRef.current = shouldStickToBottom(el);
  };

  const pickPrompt = useCallback((text: string): void => setDraft((prev) => (prev.trim() === "" ? text : `${prev}\n${text}`)), []);

  const blocked = isSendBlocked(state);
  const noticeKey = queueNoticeKey(state, canInput);
  const canSendNow = sessionId !== null && !blocked && !sending && draft.trim() !== "";

  const errorMessage = (err: unknown): string => {
    if (err instanceof ApiError && err.status === 409 && /queue is full/.test(err.message)) return t("ac.chat.queue.full", { max: CHAT_QUEUE_MAX });
    return messageOf(err);
  };

  const send = async (): Promise<void> => {
    if (sessionId === null || sendingRef.current || blocked || draft.trim() === "") return;
    const text = draft;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      // サーバーが本文を検査して予約に入れる。端末へ書くのはサーバー（手が空いたとき）
      await queueChat(sessionId, text);
      setDraft("");
      await reload();
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const cancel = async (queueId: string): Promise<void> => {
    if (sessionId === null) return;
    setSendError(null);
    try {
      await cancelChatQueue(sessionId, queueId);
    } catch (err) {
      setSendError(errorMessage(err));
    }
    await reload();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
    e.preventDefault();
    void send();
  };

  const bubble = (item: ChatItem) => {
    if (item.role === "error") {
      return (
        <div key={item.seq} className="ac-chat__notice" data-testid="chat-error" role="status">
          {t(`ac.chat.error.${item.error ?? "unknown"}`, { defaultValue: t("ac.chat.error.unknown") })}
        </div>
      );
    }
    const isUser = item.role === "user";
    return (
      <div key={item.seq} className={`ac-chat__row ac-chat__row--${item.role}`} data-testid="chat-row">
        <div className={`ac-chat__bubble ac-chat__bubble--${item.role}`} data-testid="chat-bubble" data-role={item.role}>
          {isUser ? item.text : <ChatMarkdown text={item.text} />}
          {item.truncated === true && <span className="ac-chat__truncated">{t("ac.chat.truncated")}</span>}
        </div>
      </div>
    );
  };

  const queueRow = (q: ChatQueueItem) => (
    <div key={q.id} className="ac-chat__row ac-chat__row--user" data-testid="chat-queue-item" data-state={q.state}>
      <div className="ac-chat__queued">
        <div className="ac-chat__bubble ac-chat__bubble--user ac-chat__bubble--queued">{q.text}</div>
        <div className="ac-chat__queued-meta">
          <Badge variant={q.state === "queued" ? "warning" : "info"} size="sm">
            {t(q.state === "queued" ? "ac.chat.queue.queued" : "ac.chat.queue.sent")}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => void cancel(q.id)}>
            {t(q.state === "queued" ? "ac.chat.queue.cancel" : "ac.chat.queue.cancelSent")}
          </Button>
        </div>
      </div>
    </div>
  );

  if (sessionId === null) {
    return (
      <div className="ac-chat" data-testid="chat-pane" hidden={!active}>
        <EmptyState title={t("ac.selectSession")} />
      </div>
    );
  }

  return (
    <div className="ac-chat" data-testid="chat-pane" hidden={!active}>
      <div className="ac-chat__list" ref={listRef} onScroll={handleScroll} data-testid="chat-list">
        {loadFailed && (
          <div data-testid="chat-load-error">
            <Callout variant="warning" title={t("ac.chat.loadError")} />
          </div>
        )}
        {load !== "loading" && items.length === 0 && (
          <div data-testid="chat-empty">
            <EmptyState size="compact" title={t("ac.chat.emptyTitle")} description={t("ac.chat.emptyBody")} />
          </div>
        )}
        {items.map(bubble)}
        {queued.length > 0 && (
          <p className="ac-chat__queue-note" data-testid="chat-queue-note">
            {t("ac.chat.queue.note")}
          </p>
        )}
        {queued.map(queueRow)}
      </div>
      <div className="ac-chat__composer">
        {/* バーは、このタブが開いているときだけ置く（端末の上のバーと同時に DOM に 2 本ある状態を作らない） */}
        {active && <QuickPromptBar prompts={prompts} onPick={pickPrompt} onEdit={onEditPrompts} onChanged={onPromptsChanged} />}
        {noticeKey !== null && (
          <div className="ac-chat__blocked" data-testid="chat-blocked">
            <span>{t(noticeKey)}</span>
            {state === "waiting" && (
              <Button variant="outline" size="sm" onClick={onOpenTerminal}>
                {t("ac.chat.openTerminal")}
              </Button>
            )}
          </div>
        )}
        {sendError !== null && (
          <div data-testid="chat-send-error">
            <Callout variant="warning" title={t("ac.chat.sendErrorTitle")}>
              {sendError}
            </Callout>
          </div>
        )}
        <div className="ac-chat__input-row">
          <TextareaControl
            variant="composer"
            className="ac-chat__input"
            data-testid="chat-input"
            aria-label={t("ac.chat.inputLabel")}
            placeholder={t("ac.chat.placeholder")}
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Button variant="primary" size="sm" disabled={!canSendNow} onClick={() => void send()}>
            {t("ac.chat.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
