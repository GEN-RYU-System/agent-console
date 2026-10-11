import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { Modal } from "@sa/components/Modal";
import {
  ApiError,
  checkQuickPromptSend,
  createSession,
  fetchLedger,
  fetchPastSessions,
  fetchQuickPrompts,
  fetchState,
  getSessionToken,
  logout,
  markRead,
  openSocket,
  refreshLedger,
  removeSession,
  renameSession,
  resumeSession,
} from "../api";
import { LedgerBoard } from "../components/LedgerBoard/LedgerBoard";
import { MemoryPanel } from "../components/MemoryPanel/MemoryPanel";
import { NewSessionForm, type NewSessionValues } from "../components/NewSessionForm/NewSessionForm";
import { PastSessionsList } from "../components/PastSessions/PastSessionsList";
import { QuickPromptBar } from "../components/QuickPrompts/QuickPromptBar";
import { QuickPromptEditor } from "../components/QuickPrompts/QuickPromptEditor";
import { RenameForm } from "../components/RenameForm/RenameForm";
import { SessionList } from "../components/SessionList/SessionList";
import { ThemeToggle } from "../components/ThemeToggle/ThemeToggle";
import { TerminalPane, type TerminalHandle } from "../components/TerminalPane/TerminalPane";
import type { ConsoleState, LedgerSnapshot, PastSession, QuickPrompt, SessionView } from "../types";
import "./ConsolePage.css";

const LEDGER_POLL_MS = 60000;
const RECONNECT_MS = 1000;
const RENAME_CONFIRM_MS = 10000;

function useConsoleState() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [loadFailed, setLoadFailed] = useState<"unauthorized" | "error" | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    fetchState().then(setState, (err: unknown) => setLoadFailed(err instanceof ApiError && err.status === 401 ? "unauthorized" : "error"));
    const connect = (): void => {
      ws = openSocket("/ws/events");
      ws.onmessage = (e) => {
        const snap = JSON.parse(String(e.data)) as { sessions: SessionView[]; agentsAvailable: boolean };
        setState((prev) => (prev ? { ...prev, ...snap } : prev));
      };
      ws.onclose = () => {
        // トークンが無い（未ログイン・ログアウト後）ときは再接続しない
        if (!closed && getSessionToken() !== null) timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, loadFailed, setLoadFailed };
}

export function ConsolePage() {
  const { t } = useTranslation();
  const { state, loadFailed, setLoadFailed } = useConsoleState();
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);
  const [quickEditorOpen, setQuickEditorOpen] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameNotice, setRenameNotice] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const [pastItems, setPastItems] = useState<PastSession[] | null>(null);
  const [pastAvailable, setPastAvailable] = useState(true);
  const [pastBusyId, setPastBusyId] = useState<string | null>(null);
  const [pastError, setPastError] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const sessionsRef = useRef<SessionView[]>([]);
  sessionsRef.current = state?.sessions ?? [];

  const loadQuickPrompts = useCallback(() => void fetchQuickPrompts().then((r) => setQuickPrompts(r.items), () => undefined), []);
  useEffect(loadQuickPrompts, [loadQuickPrompts]);

  const totalUnread = (state?.sessions ?? []).reduce((sum, s) => sum + s.unread, 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${t("ac.title")}` : t("ac.title");
  }, [totalUnread, t]);

  // 選択中の行は見えているので、区切りが来ても既読にする（窓が見えているときだけ）
  const selectedUnread = state?.sessions.find((s) => s.id === selectedId)?.unread ?? 0;
  useEffect(() => {
    if (selectedId !== null && selectedUnread > 0 && document.visibilityState === "visible") void markRead(selectedId).catch(() => undefined);
  }, [selectedId, selectedUnread]);

  const handleSelect = (id: string): void => {
    setSelectedId(id);
    if ((sessionsRef.current.find((s) => s.id === id)?.unread ?? 0) > 0) void markRead(id).catch(() => undefined);
  };

  useEffect(() => {
    const load = (): void => void fetchLedger().then(setLedger, () => undefined);
    load();
    const timer = setInterval(load, LEDGER_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const handleRefresh = useCallback(() => void refreshLedger().then(setLedger, () => undefined), []);

  const handleCreate = async (values: NewSessionValues): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      const { id } = await createSession(values);
      setSelectedId(id);
      setFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = (id: string): void => {
    setRemoveError(null);
    removeSession(id).catch((err: unknown) => setRemoveError(err instanceof Error ? err.message : String(err)));
  };

  const handleSendPrompt = (promptId: string): void => {
    if (selectedId === null) return;
    const checkedId = selectedId;
    setQuickError(null);
    // サーバーが状態を取り直して入れてよければ本文を返す。本文は xterm の paste() で入れてから Enter を送る。
    // 確認している間に別のセッションへ切り替わっていたら、確認したセッションの端末ではないので何も入れない
    checkQuickPromptSend(checkedId, promptId).then(
      ({ text }) => {
        if (selectedIdRef.current !== checkedId || terminalRef.current?.pasteAndEnter(checkedId, text) !== true) setQuickError(t("ac.quick.switched"));
      },
      (err: unknown) => setQuickError(err instanceof Error ? err.message : String(err)),
    );
  };

  const handleRename = async (name: string): Promise<void> => {
    if (renameTargetId === null) return;
    const targetId = renameTargetId;
    const before = sessionsRef.current.find((s) => s.id === targetId)?.name;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const { mode } = await renameSession(targetId, name);
      setRenameTargetId(null);
      if (mode === "claude") {
        // Claude 側の名前が変わらなければ案内する（/rename を受け付けない状態など）
        setTimeout(() => {
          if (sessionsRef.current.find((s) => s.id === targetId)?.name === before) setRenameNotice(targetId);
        }, RENAME_CONFIRM_MS);
      }
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  const openPastSessions = (): void => {
    setPastOpen(true);
    setPastItems(null);
    setPastError(null);
    fetchPastSessions().then(
      (r) => {
        setPastItems(r.items);
        setPastAvailable(r.available);
      },
      (err: unknown) => {
        setPastItems([]);
        setPastError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const handleResume = async (sessionId: string): Promise<void> => {
    setPastBusyId(sessionId);
    setPastError(null);
    try {
      const { id } = await resumeSession(sessionId);
      setSelectedId(id);
      setPastOpen(false);
    } catch (err) {
      setPastError(err instanceof Error ? err.message : String(err));
    } finally {
      setPastBusyId(null);
    }
  };

  const handleLogout = (): void => {
    void logout()
      .catch(() => undefined)
      .finally(() => setLoadFailed("unauthorized"));
  };

  if (loadFailed === "unauthorized") {
    return (
      <div className="ac-page__notice">
        <Callout variant="warning" title={t("ac.unauthorizedTitle")}>
          {t("ac.unauthorizedBody")}
        </Callout>
      </div>
    );
  }
  if (loadFailed) return <EmptyState title={t("ac.loadError")} />;
  if (!state) return null;
  // 一覧から外れた（または存在しない）セッションは選択扱いにしない
  const activeId = state.sessions.some((s) => s.id === selectedId) ? selectedId : null;
  const activeSession = state.sessions.find((s) => s.id === activeId);
  const renameTarget = state.sessions.find((s) => s.id === renameTargetId);
  const canResume = state.roles.some((r) => r.canResume);

  return (
    <div className="ac-page">
      <aside className="ac-page__left">
        <div className="ac-page__bar">
          <h1 className="ac-page__title">{t("ac.sessions")}</h1>
          <Button size="sm" onClick={() => setFormOpen(true)}>
            {t("ac.newSession")}
          </Button>
        </div>
        <div className="ac-page__subbar">
          <Button variant="outline" size="sm" onClick={openPastSessions}>
            {t("ac.pastSessions")}
          </Button>
        </div>
        {removeError !== null && (
          <Callout variant="warning" title={t("ac.removeError")}>
            {removeError}
          </Callout>
        )}
        {renameNotice !== null && (
          <Callout variant="warning" title={t("ac.rename.notReflectedTitle")}>
            {t("ac.rename.notReflectedBody")}
          </Callout>
        )}
        <SessionList
          sessions={state.sessions}
          roles={state.roles}
          selectedId={activeId}
          onSelect={handleSelect}
          onRemove={handleRemove}
          onRename={(id) => {
            setRenameNotice(null);
            setRenameError(null);
            setRenameTargetId(id);
          }}
        />
        <p className="ac-page__help" data-testid="notify-help">
          {t("ac.notifyHelp")}
        </p>
      </aside>
      <main className="ac-page__center">
        <QuickPromptBar
          prompts={quickPrompts}
          canSend={activeSession?.canInput === true}
          onSend={handleSendPrompt}
          onEdit={() => setQuickEditorOpen(true)}
        />
        {quickError !== null && (
          <Callout variant="warning" title={t("ac.quick.sendError")}>
            {quickError}
          </Callout>
        )}
        <div className="ac-page__terminal">{activeId ? <TerminalPane ref={terminalRef} sessionId={activeId} /> : <EmptyState title={t("ac.selectSession")} />}</div>
      </main>
      <aside className="ac-page__right">
        <LedgerBoard snapshot={ledger} onRefresh={handleRefresh} />
      </aside>
      <footer className="ac-page__footer" data-testid="footer">
        <span data-testid="sa-source">
          {t("ac.footer.saSource")}: {state.saSource.slice(0, 12)}
        </span>
        <span data-testid="app-version">
          {t("ac.footer.version")}: {state.appVersion}
        </span>
        {state.commit !== "" && (
          <span data-testid="commit">
            {t("ac.footer.commit")}: {state.commit.slice(0, 7)}
          </span>
        )}
        <span data-testid="claude-version">
          {t("ac.footer.claudeVersion")}: {state.claudeVersion}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setMemoryOpen(true)}>
          {t("ac.memory.open")}
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          {t("ac.logout")}
        </Button>
      </footer>
      <Modal open={renameTarget !== undefined} onClose={() => setRenameTargetId(null)} title={t("ac.rename.title")} size="sm">
        {renameTarget !== undefined && (
          <RenameForm key={renameTarget.id} session={renameTarget} busy={renameBusy} error={renameError} onSubmit={(n) => void handleRename(n)} />
        )}
      </Modal>
      <Modal open={quickEditorOpen} onClose={() => setQuickEditorOpen(false)} title={t("ac.quick.editTitle")} size="md">
        <QuickPromptEditor prompts={quickPrompts} onChanged={loadQuickPrompts} />
      </Modal>
      <Modal open={pastOpen} onClose={() => setPastOpen(false)} title={t("ac.past.title")} size="lg">
        <PastSessionsList items={pastItems} available={pastAvailable} canResume={canResume} roles={state.roles} busyId={pastBusyId} error={pastError} onResume={(id) => void handleResume(id)} />
      </Modal>
      <Modal open={memoryOpen} onClose={() => setMemoryOpen(false)} title={t("ac.memory.title")} size="md">
        <MemoryPanel open={memoryOpen} />
      </Modal>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={t("ac.newSession")} size="sm">
        <NewSessionForm roles={state.roles} busy={busy} error={formError} onSubmit={(v) => void handleCreate(v)} />
      </Modal>
    </div>
  );
}
