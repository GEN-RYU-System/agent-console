import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { checkPicksSend, deletePick, fetchPickImage, fetchPicks, markPicksSent, updatePickNote } from "../../api";
import type { PickItem, SessionState } from "../../types";
import type { PasteFn } from "../DiffPane/DiffPane";
import "./PicksPane.css";

const NOTE_ROWS = 2;
const NOTE_MAX_CHARS = 2000;
const TEXT_HEAD_CHARS = 120;

interface Props {
  /** 送り先の（選んでいる）セッション。無いときは null */
  sessionId: string | null;
  /** 「部品」タブが開いているか（閉じている間は取得しない） */
  active: boolean;
  /** 未送信の部品の数（変わったら取り直す。サーバーが配信する値） */
  unsent: number;
  state: SessionState;
  /** 今、端末へ文章を入れてよい状態か（セッション一覧と同じ判定） */
  canInput: boolean;
  /** 端末へ貼って Enter を送る（TerminalPane の pasteSubmitAfter） */
  paste: PasteFn;
}

const BLOCKED_KEY: Partial<Record<SessionState, string>> = {
  working: "ac.picks.blocked.working",
  waiting: "ac.picks.blocked.waiting",
  stopped: "ac.picks.blocked.stopped",
  unknown: "ac.picks.blocked.unknown",
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function Detail({ pick }: { pick: PickItem }): ReactElement {
  const { t } = useTranslation();
  const styleLines = Object.entries(pick.style).map(([k, v]) => `${k}: ${v}`);
  const attrLines = Object.entries(pick.attrs).map(([k, v]) => `${k}=${v}`);
  return (
    <dl className="ac-picks__detail">
      <dt>{t("ac.picks.detailSelector")}</dt>
      <dd className="ac-picks__mono">{pick.selector}</dd>
      <dt>{t("ac.picks.detailAttrs")}</dt>
      <dd className="ac-picks__mono">{attrLines.join(", ")}</dd>
      <dt>{t("ac.picks.detailStyle")}</dt>
      <dd>
        <pre className="ac-picks__pre">{styleLines.join("\n")}</pre>
      </dd>
      <dt>{t("ac.picks.detailRect")}</dt>
      <dd className="ac-picks__mono">{`${Math.round(pick.rect.x)}, ${Math.round(pick.rect.y)} / ${Math.round(pick.rect.w)} × ${Math.round(pick.rect.h)}`}</dd>
      <dt>{t("ac.picks.detailHtml")}</dt>
      <dd>
        <pre className="ac-picks__pre">{pick.html}</pre>
      </dd>
    </dl>
  );
}

/** 「部品」タブの中身。正本はサーバーの dataDir/picks/ で、ここは写しだけ。指示（ひとこと）を書いて送る操作は、必ずこの画面で人が行う。 */
export function PicksPane({ sessionId, active, unsent, state, canInput, paste }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [extensionDir, setExtensionDir] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const seq = useRef(0);
  const seen = useRef<Set<string>>(new Set());
  const imageRequested = useRef<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const result = await fetchPicks();
      if (seq.current !== mine) return;
      setItems(result.items);
      setExtensionDir(result.extensionDir);
      setLoadFailed(false);
      // 初めて見る未送信の部品は、最初から送る対象にする
      const fresh = result.items.filter((p) => !seen.current.has(p.id) && p.sentAt === undefined).map((p) => p.id);
      for (const p of result.items) seen.current.add(p.id);
      if (fresh.length > 0) setSelected((prev) => new Set([...prev, ...fresh]));
      for (const p of result.items) {
        if (!p.hasImage || imageRequested.current.has(p.id)) continue;
        imageRequested.current.add(p.id);
        fetchPickImage(p.id).then(
          (dataUrl) => setImages((prev) => ({ ...prev, [p.id]: dataUrl })),
          () => imageRequested.current.delete(p.id),
        );
      }
    } catch {
      if (seq.current === mine) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, unsent, load]);

  const list = items ?? [];
  const chosen = list.filter((p) => selected.has(p.id));

  const toggleSelected = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExpanded = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 書きかけのひとことを保存する。失敗したら例外（書いた内容は残す）。 */
  const saveNote = useCallback(async (pick: PickItem, draft: string): Promise<void> => {
    if (draft === pick.note) return;
    const saved = await updatePickNote(pick.id, draft);
    setItems((prev) => (prev ?? []).map((p) => (p.id === pick.id ? saved : p)));
    setDrafts((prev) => {
      const { [pick.id]: _done, ...rest } = prev;
      return rest;
    });
  }, []);

  const handleBlur = (pick: PickItem): void => {
    const draft = drafts[pick.id];
    if (draft === undefined) return;
    setError(null);
    saveNote(pick, draft).catch((err: unknown) => setError({ title: t("ac.picks.noteError"), message: messageOf(err) }));
  };

  const handleDelete = (id: string): void => {
    setError(null);
    deletePick(id).then(
      () => {
        setItems((prev) => (prev ?? []).filter((p) => p.id !== id));
        setSelected((prev) => new Set([...prev].filter((x) => x !== id)));
      },
      (err: unknown) => setError({ title: t("ac.picks.deleteError"), message: messageOf(err) }),
    );
  };

  const handleSend = async (): Promise<void> => {
    if (sessionId === null) return;
    const id = sessionId;
    setSending(true);
    setNotice(null);
    setError(null);
    try {
      // ひとことを先に保存する。サーバーはそれを読んで依頼文を作る
      for (const pick of chosen) {
        const draft = drafts[pick.id];
        if (draft !== undefined) await saveNote(pick, draft);
      }
      // サーバーが入れてよい状態か取り直して文章を返す。貼る・待つ・Enter は端末の部品が行い、貼れたと分かってから送信済みにする
      const { text, ids, submitDelayMs } = await checkPicksSend(id, chosen.map((p) => p.id));
      const result = await paste(id, text, submitDelayMs);
      if (result === "notPasted") setNotice(t("ac.quick.switched"));
      else if (result === "pastedNotSent") setNotice(t("ac.picks.pastedNotSent"));
      else {
        await markPicksSent(ids);
        const now = Date.now();
        setItems((prev) => (prev ?? []).map((p) => (ids.includes(p.id) ? { ...p, sentAt: now } : p)));
        setSelected((prev) => new Set([...prev].filter((x) => !ids.includes(x))));
      }
    } catch (err) {
      setError({ title: t("ac.picks.sendErrorTitle"), message: messageOf(err) });
    } finally {
      setSending(false);
    }
  };

  const blockedReason = (): string | null => {
    if (sending) return t("ac.picks.sending");
    if (sessionId === null) return t("ac.picks.noSession");
    if (!canInput) return t(BLOCKED_KEY[state] ?? "ac.picks.blocked.other");
    if (chosen.length === 0) return t("ac.picks.nothingSelected");
    return null;
  };
  const reason = blockedReason();

  const body = (): ReactElement => {
    if (loadFailed && items === null) return <Callout variant="warning" title={t("ac.picks.loadError")} />;
    if (items === null) return <EmptyState size="compact" title={t("ac.picks.loading")} />;
    if (list.length === 0) {
      return (
        <EmptyState
          size="compact"
          title={t("ac.picks.emptyTitle")}
          description={t("ac.picks.emptyBody")}
          action={
            <Stack gap="2">
              <h3 className="ac-picks__setup-title">{t("ac.picks.setupTitle")}</h3>
              <ol className="ac-picks__setup">
                <li>{t("ac.picks.setupStep1")}</li>
                <li>
                  {t("ac.picks.setupStep2")}
                  <code className="ac-picks__dir">{extensionDir}</code>
                </li>
                <li>{t("ac.picks.setupStep3")}</li>
              </ol>
              <p className="ac-picks__setup-note">{t("ac.picks.setupUpdate")}</p>
            </Stack>
          }
        />
      );
    }
    return (
      <div className="ac-picks__list">
        {list.map((pick) => {
          const isSelected = selected.has(pick.id);
          const isOpen = expanded.has(pick.id);
          const head = pick.text.trim() === "" ? t("ac.picks.noText") : pick.text.slice(0, TEXT_HEAD_CHARS);
          return (
            <Card key={pick.id} density="compact" data-testid="pick-item">
              <div className="ac-picks__item">
                <div className="ac-picks__media">
                  {pick.hasImage ? (
                    images[pick.id] !== undefined && <img className="ac-picks__img" src={images[pick.id]} alt={t("ac.picks.imageAlt")} />
                  ) : (
                    <span className="ac-picks__noimage">{t("ac.picks.noImage", { reason: pick.imageError === "" ? t("ac.picks.noImageUnknown") : pick.imageError })}</span>
                  )}
                </div>
                <Stack gap="2">
                  <div className="ac-picks__head">
                    <span className="ac-picks__host">{hostOf(pick.url)}</span>
                    {pick.sentAt !== undefined && (
                      <Badge variant="success" size="sm">
                        {t("ac.picks.sent")}
                      </Badge>
                    )}
                    <span className="ac-picks__time">{t("ac.picks.receivedAt", { time: new Date(pick.createdAt).toLocaleTimeString("ja-JP") })}</span>
                  </div>
                  <p className="ac-picks__text">{head}</p>
                  <Textarea
                    aria-label={t("ac.picks.noteLabel")}
                    value={drafts[pick.id] ?? pick.note}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [pick.id]: e.target.value }))}
                    onBlur={() => handleBlur(pick)}
                    maxLength={NOTE_MAX_CHARS}
                    rows={NOTE_ROWS}
                    size="sm"
                    fullWidth
                  />
                  <div className="ac-picks__actions">
                    <Button size="sm" variant="tab" active={isSelected} onClick={() => toggleSelected(pick.id)}>
                      {isSelected ? t("ac.picks.selected") : t("ac.picks.select")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleExpanded(pick.id)} aria-expanded={isOpen}>
                      {isOpen ? t("ac.picks.hideDetail") : t("ac.picks.showDetail")}
                    </Button>
                    <Button size="sm" variant="ghost" layoutClassName="comp-btn-layout--ml-auto" onClick={() => handleDelete(pick.id)}>
                      {t("ac.picks.delete")}
                    </Button>
                  </div>
                  {isOpen && <Detail pick={pick} />}
                </Stack>
              </div>
            </Card>
          );
        })}
      </div>
    );
  };

  return (
    <div className="ac-picks" hidden={!active} data-testid="picks-pane">
      <div className="ac-picks__toolbar">
        {reason !== null && (
          <span className="ac-picks__reason" data-testid="picks-send-reason">
            {reason}
          </span>
        )}
        <Button size="sm" layoutClassName="comp-btn-layout--ml-auto" disabled={reason !== null} onClick={() => void handleSend()}>
          {t("ac.picks.send", { count: chosen.length })}
        </Button>
      </div>
      {notice !== null && (
        <Callout variant="warning" title={t("ac.picks.sendNoticeTitle")}>
          {notice}
        </Callout>
      )}
      {error !== null && (
        <Callout variant="warning" title={error.title}>
          {error.message}
        </Callout>
      )}
      {loadFailed && items !== null && <Callout variant="warning" title={t("ac.picks.loadError")} />}
      <div className="ac-picks__body">{body()}</div>
    </div>
  );
}
