import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import {
  ApiError,
  checkDiffCommentsSend,
  createDiffComment,
  deleteDiffComment,
  fetchDiff,
  fetchDiffComments,
  fetchDiffFile,
  markDiffCommentsSent,
  updateDiffComment,
} from "../../api";
import type { ChangedFile, DiffComment, DiffCommentInput, FileDiff, SessionState } from "../../types";
import type { PasteResult } from "../TerminalPane/TerminalPane";
import { DiffView } from "./DiffView";
import "./DiffPane.css";

export type PasteFn = (sessionId: string, text: string, delayMs: number) => Promise<PasteResult>;

interface Props {
  sessionId: string;
  /** 「変更」タブが開いているか（閉じている間も、件数のために一覧は読む） */
  active: boolean;
  state: SessionState;
  /** 今、端末へ文章を入れてよい状態か（セッション一覧と同じ判定） */
  canInput: boolean;
  /** 端末へ貼って Enter を送る（TerminalPane の pasteSubmitAfter） */
  paste: PasteFn;
  /** ファイル一覧の件数（読めていない間は null） */
  onCountChange: (count: number | null) => void;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; baseRef: string; files: ChangedFile[] }
  | { kind: "noBase"; baseRef: string }
  | { kind: "outside" }
  | { kind: "error" };
type FileState = { path: string; diff: FileDiff | "loading" | "error" };
type Comments = DiffComment[] | "unreadable";

const BLOCKED_KEY: Partial<Record<SessionState, string>> = {
  working: "ac.diff.blocked.working",
  waiting: "ac.diff.blocked.waiting",
  stopped: "ac.diff.blocked.stopped",
  unknown: "ac.diff.blocked.unknown",
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 「変更」タブの中身。一覧・1 ファイルの変更・行ごとのコメント・Claude に送る。正本は git とサーバーのコメントファイルで、ここは写しだけ。 */
export function DiffPane({ sessionId, active, state, canInput, paste, onCountChange }: Props) {
  const { t } = useTranslation();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [comments, setComments] = useState<Comments | null>(null);
  const [file, setFile] = useState<FileState | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const loadedFor = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const seq = useRef(0);

  /** refresh: 開いているファイルを読み直すだけのとき。表示（と書きかけのコメント欄）は消さず、届いたら差し替える。 */
  const openFile = useCallback(async (id: string, path: string, refresh = false): Promise<void> => {
    selectedRef.current = path;
    if (!refresh) setFile({ path, diff: "loading" });
    try {
      const diff = await fetchDiffFile(id, path);
      if (sessionRef.current === id && selectedRef.current === path) setFile({ path, diff });
    } catch {
      if (sessionRef.current === id && selectedRef.current === path) setFile({ path, diff: "error" });
    }
  }, []);

  const load = useCallback(
    async (id: string): Promise<void> => {
      const mine = ++seq.current;
      const [listResult, commentsResult] = await Promise.allSettled([fetchDiff(id), fetchDiffComments(id)]);
      if (seq.current !== mine || sessionRef.current !== id) return;
      if (listResult.status === "fulfilled") {
        const value = listResult.value;
        setList("error" in value ? { kind: "noBase", baseRef: value.baseRef } : { kind: "ok", baseRef: value.baseRef, files: value.files });
        if (!("error" in value) && selectedRef.current !== null && value.files.some((f) => f.path === selectedRef.current)) void openFile(id, selectedRef.current, true);
        else {
          selectedRef.current = null;
          setFile(null);
        }
      } else {
        const reason = listResult.reason as unknown;
        setList(reason instanceof ApiError && reason.status === 409 ? { kind: "outside" } : { kind: "error" });
      }
      if (commentsResult.status === "fulfilled") setComments(commentsResult.value.items);
      else {
        const reason = commentsResult.reason as unknown;
        setComments(reason instanceof ApiError && reason.status === 409 ? [] : "unreadable");
      }
    },
    [openFile],
  );

  useEffect(() => {
    if (loadedFor.current === sessionId && !active) return;
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      selectedRef.current = null;
      setList({ kind: "loading" });
      setComments(null);
      setFile(null);
      setError(null);
      setNotice(null);
    }
    void load(sessionId);
  }, [sessionId, active, load]);

  useEffect(() => onCountChange(list.kind === "ok" ? list.files.length : null), [list, onCountChange]);

  const saveComment = async (input: DiffCommentInput, editingId: string | null): Promise<void> => {
    const saved = editingId === null ? await createDiffComment(sessionId, input) : await updateDiffComment(sessionId, editingId, input);
    setComments((prev) => (Array.isArray(prev) ? (editingId === null ? [...prev, saved] : prev.map((c) => (c.id === editingId ? saved : c))) : prev));
  };

  const removeComment = async (commentId: string): Promise<void> => {
    setError(null);
    try {
      await deleteDiffComment(sessionId, commentId);
      setComments((prev) => (Array.isArray(prev) ? prev.filter((c) => c.id !== commentId) : prev));
    } catch (err) {
      setError({ title: t("ac.diff.commentDeleteError"), message: messageOf(err) });
    }
  };

  const items = Array.isArray(comments) ? comments : [];
  const unsent = items.filter((c) => c.sentAt === undefined).length;

  const handleSend = async (): Promise<void> => {
    const id = sessionId;
    setSending(true);
    setNotice(null);
    setError(null);
    try {
      // サーバーが入れてよい状態か取り直して文章を返す。貼る・待つ・Enter は端末の部品が行い、貼れたと分かってから送信済みにする
      const { text, ids, submitDelayMs } = await checkDiffCommentsSend(id);
      const result = await paste(id, text, submitDelayMs);
      if (result === "notPasted") setNotice(t("ac.quick.switched"));
      else if (result === "pastedNotSent") setNotice(t("ac.diff.pastedNotSent"));
      else {
        await markDiffCommentsSent(id, ids);
        if (sessionRef.current === id) {
          const now = Date.now();
          setComments((prev) => (Array.isArray(prev) ? prev.map((c) => (ids.includes(c.id) ? { ...c, sentAt: now } : c)) : prev));
        }
      }
    } catch (err) {
      setError({ title: t("ac.diff.sendErrorTitle"), message: messageOf(err) });
    } finally {
      setSending(false);
    }
  };

  const blockedReason = (): string | null => {
    if (sending) return t("ac.diff.sending");
    if (!canInput) return t(BLOCKED_KEY[state] ?? "ac.diff.blocked.other");
    if (unsent === 0) return t("ac.diff.nothingToSend");
    return null;
  };
  const reason = blockedReason();

  const body = (): ReactElement => {
    if (list.kind === "loading") return <EmptyState size="compact" title={t("ac.diff.loading")} />;
    if (list.kind === "outside") return <EmptyState size="compact" title={t("ac.diff.outside")} description={t("ac.diff.outsideHint")} />;
    if (list.kind === "noBase") return <EmptyState size="compact" title={t("ac.diff.noBase", { ref: list.baseRef })} description={t("ac.diff.noBaseHint")} />;
    if (list.kind === "error") return <EmptyState size="compact" title={t("ac.diff.loadError")} />;
    if (list.files.length === 0) return <EmptyState size="compact" title={t("ac.diff.empty")} />;
    const perFile = (path: string): number => items.filter((c) => c.path === path).length;
    return (
      <div className="ac-diff__body">
        <nav className="ac-diff__files" aria-label={t("ac.diff.fileList")}>
          {list.files.map((f) => (
            <Button
              key={f.path}
              variant="ghost"
              size="sm"
              layoutClassName="ac-diff__file"
              aria-current={file?.path === f.path ? "true" : undefined}
              onClick={() => void openFile(sessionId, f.path)}
            >
              <span className="ac-diff__file-name">{f.path}</span>
              <span className="ac-diff__file-meta">
                {f.untracked && (
                  <Badge variant="info" size="sm">
                    {t("ac.diff.untracked")}
                  </Badge>
                )}
                {!f.untracked && !f.binary && (
                  <>
                    <Badge variant="success" size="sm">
                      {t("ac.diff.added", { count: f.added })}
                    </Badge>
                    <Badge variant="danger" size="sm">
                      {t("ac.diff.removed", { count: f.removed })}
                    </Badge>
                  </>
                )}
                {perFile(f.path) > 0 && (
                  <span className="ac-diff__file-comments" title={t("ac.diff.commentCount", { count: perFile(f.path) })}>
                    <MessageSquare className="ac-diff__mark" aria-hidden="true" />
                    {perFile(f.path)}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </nav>
        <section className="ac-diff__main">{fileBody()}</section>
      </div>
    );
  };

  const fileBody = (): ReactElement => {
    if (file === null) return <EmptyState size="compact" title={t("ac.diff.selectFile")} />;
    const diff = file.diff;
    if (diff === "loading") return <EmptyState size="compact" title={t("ac.diff.loading")} />;
    if (diff === "error") return <EmptyState size="compact" title={t("ac.diff.fileError")} />;
    const fileComments = items.filter((c) => c.path === file.path);
    if ("lines" in diff) return <DiffView key={file.path} path={file.path} lines={diff.lines} comments={fileComments} onSave={saveComment} onDelete={removeComment} />;
    const message = "tooLarge" in diff ? t("ac.diff.tooLarge") : "binary" in diff ? t("ac.diff.binary") : t("ac.diff.untrackedBody");
    return (
      <DiffView key={file.path} path={file.path} lines={[]} comments={fileComments} onSave={saveComment} onDelete={removeComment} note={message} />
    );
  };

  return (
    <div className="ac-diff" hidden={!active} data-testid="diff-pane">
      <div className="ac-diff__toolbar">
        {list.kind === "ok" && <span className="ac-diff__base">{t("ac.diff.base", { ref: list.baseRef })}</span>}
        <Button size="sm" variant="outline" layoutClassName="comp-btn-layout--ml-auto" onClick={() => void load(sessionId)}>
          {t("ac.diff.refresh")}
        </Button>
        {list.kind === "ok" && (
          <>
            {reason !== null && (
              <span className="ac-diff__reason" data-testid="send-reason">
                {reason}
              </span>
            )}
            <Button size="sm" disabled={reason !== null} onClick={() => void handleSend()}>
              {t("ac.diff.send", { count: unsent })}
            </Button>
          </>
        )}
      </div>
      {comments === "unreadable" && (
        <Callout variant="warning" title={t("ac.diff.commentsUnreadable")}>
          {t("ac.diff.commentsUnreadableHint")}
        </Callout>
      )}
      {notice !== null && (
        <Callout variant="warning" title={t("ac.diff.sendNoticeTitle")}>
          {notice}
        </Callout>
      )}
      {error !== null && (
        <Callout variant="warning" title={error.title}>
          {error.message}
        </Callout>
      )}
      {body()}
    </div>
  );
}
