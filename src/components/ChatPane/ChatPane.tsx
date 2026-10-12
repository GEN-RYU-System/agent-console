import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { TextareaControl } from "@sa/components/Textarea";
import { checkChatSend, fetchChat } from "../../api";
import type { ChatItem, QuickPrompt, SessionState } from "../../types";
import { QuickPromptBar } from "../QuickPrompts/QuickPromptBar";
import { ChatMarkdown } from "./ChatMarkdown";
import { blockedReasonKey, isSendKey, mergeChat, shouldStickToBottom } from "./chatLogic";
import "./ChatPane.css";

type PasteResult = "sent" | "notPasted" | "pastedNotSent";
type PasteFn = (sessionId: string, text: string, delayMs: number) => Promise<PasteResult>;

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
  /** 端末へ貼って、待ってから Enter を送る（TerminalPane の pasteSubmitAfter） */
  paste: PasteFn;
  prompts: QuickPrompt[];
  onEditPrompts: () => void;
  onPromptsChanged: () => void;
  /** 端末タブへ移る（確認の待ちのときの案内の Button） */
  onOpenTerminal: () => void;
}

type Load = "loading" | "noSession" | "ok";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 「チャット」タブ。選んだセッションの会話（hook の記録から作る）を、右にしんごさん・左に Claude の吹き出しで出し、下の入力欄から送る。正本は記録のファイルで、ここは写しだけ。 */
export function ChatPane({ sessionId, active, rev, state, canInput, paste, prompts, onEditPrompts, onPromptsChanged, onOpenTerminal }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 送ったとき（手元で見えていた最後の seq）。これより新しい user の記録が届くまで「送りました」を出す */
  const [sentAfterSeq, setSentAfterSeq] = useState<number | null>(null);
  const cursor = useRef<{ lastSeq: number; epoch: string | null }>({ lastSeq: 0, epoch: null });
  const sendingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 会話を取る: 開いたとき・記録の版が進んだとき。続きだけ（since=最後の seq、epoch つき）
  useEffect(() => {
    if (!active || sessionId === null) return;
    let cancelled = false;
    fetchChat(sessionId, cursor.current.lastSeq, cursor.current.epoch).then(
      (res) => {
        if (cancelled) return;
        setLoadFailed(false);
        if (res.status === "noSession") {
          setLoad("noSession");
          return;
        }
        cursor.current = { lastSeq: res.lastSeq, epoch: res.epoch };
        setItems((prev) => mergeChat(prev, res.items, res.reset));
        setLoad("ok");
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, rev]);

  // 送った文章が会話に届いたら（新しい user の記録が来たら）「送りました」を消す
  useEffect(() => {
    if (sentAfterSeq !== null && items.some((i) => i.role === "user" && i.seq > sentAfterSeq)) setSentAfterSeq(null);
  }, [items, sentAfterSeq]);

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

  const blockedKey = blockedReasonKey(state, canInput);
  const canSendNow = sessionId !== null && blockedKey === null && !sending && draft.trim() !== "";

  const send = async (): Promise<void> => {
    if (sessionId === null || sendingRef.current || blockedKey !== null || draft.trim() === "") return;
    const text = draft;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      // サーバーが本文を検査し、状態を取り直して、手すきのときだけ返す。そのあと画面が端末へ貼って、待ってから Enter を送る
      const checked = await checkChatSend(sessionId, text);
      const result = await paste(sessionId, checked.text, checked.submitDelayMs);
      if (result === "sent") {
        setDraft("");
        setSentAfterSeq(cursor.current.lastSeq);
      } else if (result === "pastedNotSent") {
        setDraft("");
        setSendError(t("ac.chat.pastedNotSent"));
      } else {
        setSendError(t("ac.chat.switched"));
      }
    } catch (err) {
      setSendError(messageOf(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
      </div>
      <div className="ac-chat__composer">
        <QuickPromptBar prompts={prompts} onPick={pickPrompt} onEdit={onEditPrompts} onChanged={onPromptsChanged} />
        {blockedKey !== null && (
          <div className="ac-chat__blocked" data-testid="chat-blocked">
            <span>{t(blockedKey)}</span>
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
        {sentAfterSeq !== null && (
          <p className="ac-chat__sent" data-testid="chat-sent-notice">
            {t("ac.chat.sent")}
          </p>
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
