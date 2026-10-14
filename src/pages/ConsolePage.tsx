import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import ConfirmModal from "@sa/components/ConfirmModal";
import { Modal } from "@sa/components/Modal";
import { Tabs } from "@sa/components/Tabs";
import {
  ApiError,
  checkQuickPromptSend,
  closeSession,
  relaySession,
  moveSession,
  createSession,
  fetchLedger,
  fetchResumeTargets,
  fetchQuickPrompts,
  clearSessionToken,
  fetchState,
  getSessionToken,
  logout,
  markRead,
  openSocket,
  refreshLedger,
  removeSession,
  renameSession,
  resumeSession,
  startAccountLogin,
} from "../api";
import { AccountBadge } from "../components/AccountBadge/AccountBadge";
import { ChatPane } from "../components/ChatPane/ChatPane";
import { DiffPane } from "../components/DiffPane/DiffPane";
import { FilesPane } from "../components/FilesPane/FilesPane";
import { MemoryPanel } from "../components/MemoryPanel/MemoryPanel";
import { PicksPane } from "../components/PicksPane/PicksPane";
import { PrPane } from "../components/PrPane/PrPane";
import { RightPane } from "../components/RightPane/RightPane";
import { NewSessionForm, type NewSessionValues } from "../components/NewSessionForm/NewSessionForm";
import { ResumePicker } from "../components/ResumePicker/ResumePicker";
import { QuickPromptBar } from "../components/QuickPrompts/QuickPromptBar";
import { QuickPromptEditor } from "../components/QuickPrompts/QuickPromptEditor";
import { RenameForm } from "../components/RenameForm/RenameForm";
import { SessionList } from "../components/SessionList/SessionList";
import { ThemeToggle } from "../components/ThemeToggle/ThemeToggle";
import { UsageMeter } from "../components/UsageMeter/UsageMeter";
import { RoutinesPane } from "../components/Routines/RoutinesPane";
import { ReservationsPane } from "../components/Reservations/ReservationsPane";
import { TerminalPane, type PasteResult, type TerminalHandle, type UploadNotice } from "../components/TerminalPane/TerminalPane";
import { ACCOUNT_LOGIN_ROLE_ID, type ConsoleState, type LedgerSnapshot, type QuickPrompt, type RelayView, type ResumeTarget, type SessionState, type SessionView } from "../types";
import "./ConsolePage.css";

const LEDGER_POLL_MS = 60000;
const RECONNECT_MS = 1000;
const RENAME_CONFIRM_MS = 10000;
const UPLOAD_NOTICE_MS = 8000;
const BYTES_PER_MB = 1024 * 1024;

type CenterTab = "chat" | "terminal" | "changes" | "files" | "pr" | "picks" | "routines" | "reservations";

/** onopen の無いまま切れた回数がこの数に達したら、/api/state を取り直して原因（ログイン切れ）を確かめる */
const CONNECT_FAILURES_BEFORE_CHECK = 3;

function useConsoleState() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [loadFailed, setLoadFailed] = useState<"unauthorized" | "error" | null>(null);
  /** 最初に読んだ版と違う版のサーバーにつながり直した（更新が入った） */
  const [newVersion, setNewVersion] = useState(false);

  useEffect(() => {
    let closed = false;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** onopen が来ないまま onclose した回数（onopen で 0 に戻す） */
    let failures = 0;
    /** 一度でも切れたか（切れた後の onopen では取り直す） */
    let dropped = false;
    let checking = false;
    let firstCommit: string | null = null;

    // 取り直した state は丸ごと置き換える（版・commit など /api/state にしか無い項目も新しくなる）
    const adopt = (next: ConsoleState): void => {
      if (closed) return;
      if (firstCommit === null) firstCommit = next.commit;
      else if (firstCommit !== "" && next.commit !== "" && next.commit !== firstCommit) setNewVersion(true);
      setState(next);
    };

    fetchState().then(adopt, (err: unknown) => setLoadFailed(err instanceof ApiError && err.status === 401 ? "unauthorized" : "error"));

    const checkLogin = (): void => {
      checking = true;
      fetchState().then(
        (next) => {
          checking = false;
          failures = 0;
          adopt(next);
        },
        (err: unknown) => {
          checking = false;
          failures = 0;
          if (closed) return;
          if (err instanceof ApiError && err.status === 401) {
            // ログインが切れている: 案内を出し、つなぎ直しをやめる
            stopped = true;
            clearTimeout(timer);
            clearSessionToken();
            setLoadFailed("unauthorized");
          }
          // それ以外（再起動中で接続できない・500）は画面をそのまま、つなぎ直しを続ける
        },
      );
    };

    const connect = (): void => {
      const socket = openSocket("/ws/events");
      ws = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        failures = 0;
        if (dropped) fetchState().then(adopt, () => undefined);
      };
      socket.onmessage = (e) => {
        const snap = JSON.parse(String(e.data)) as { sessions: SessionView[]; agentsAvailable: boolean };
        setState((prev) => (prev ? { ...prev, ...snap } : prev));
      };
      socket.onclose = () => {
        dropped = true;
        // トークンが無い（未ログイン・ログアウト後）ときは再接続しない
        if (closed || stopped || getSessionToken() === null) return;
        // onopen の無いまま閉じた回数だけ数える（つながってから切れたときは数え直し）
        failures = opened ? 0 : failures + 1;
        if (failures >= CONNECT_FAILURES_BEFORE_CHECK && !checking) checkLogin();
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, loadFailed, setLoadFailed, newVersion };
}

/** 端末のよく使う指示が押せない理由の文言キー（stopped・unknown 以外は確認待ち） */
function quickBlockedKey(state: SessionState): string {
  if (state === "stopped") return "ac.quick.blockedStopped";
  if (state === "unknown") return "ac.quick.blockedUnknown";
  return "ac.quick.blockedWaiting";
}

export function ConsolePage() {
  const { t } = useTranslation();
  const { state, loadFailed, setLoadFailed, newVersion } = useConsoleState();
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);
  const [quickEditorOpen, setQuickEditorOpen] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameNotice, setRenameNotice] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeItems, setResumeItems] = useState<ResumeTarget[] | null>(null);
  const [resumeBusyPath, setResumeBusyPath] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [accountConfirmOpen, setAccountConfirmOpen] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  // アカウント切り替えの端末が「停止」に変わったら（一覧に初めて載ったときにもう停止していた場合を含む）、下の帯のアカウント表示を取り直す
  const [accountRefreshKey, setAccountRefreshKey] = useState(0);
  const prevStatesRef = useRef<Map<string, SessionState>>(new Map());
  // 最初に開くタブはチャット（端末は隠れた状態で開き、端末タブを押すと見える。大きさは見えたときに合う）
  const [centerTab, setCenterTab] = useState<CenterTab>("chat");
  const [diffCount, setDiffCount] = useState<number | null>(null);
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  // 引き継ぎ: 確認中の古い側、失敗の案内、画面側で隠した relayId、選択を切り替え済みの relayId
  const [relayTargetId, setRelayTargetId] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [dismissedRelays, setDismissedRelays] = useState<ReadonlySet<string>>(() => new Set<string>());
  const handledRelaysRef = useRef<Set<string>>(new Set<string>());
  // 復元の案内は、閉じた内容を覚えておく（メモリだけ。同じ内容は出し直さない）
  const [dismissedNotices, setDismissedNotices] = useState<string | null>(null);
  const [dismissedTerminalNotices, setDismissedTerminalNotices] = useState<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  // 引き継ぎが終わったとき、選択中が古い側なら新しい側を選ぶ（同じ relayId では 1 回だけ）
  const relays = state?.relays;
  useEffect(() => {
    for (const r of relays ?? []) {
      if (r.phase !== "done" || r.newSessionId === undefined || handledRelaysRef.current.has(r.relayId)) continue;
      handledRelaysRef.current.add(r.relayId);
      if (selectedIdRef.current === r.oldSessionId) setSelectedId(r.newSessionId);
    }
  }, [relays]);
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
  // 送信の警告は、別のセッションを選んだとき、または今のセッションが送れる状態に戻ったときに消す
  const selectedCanChat = state?.sessions.find((s) => s.id === selectedId)?.canChat;
  useEffect(() => {
    setQuickError(null);
  }, [selectedId, selectedCanChat]);

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

  // 画像の案内は、しばらくしたら消す（Callout は閉じるボタンを持たない）
  useEffect(() => {
    if (uploadNotice === null) return;
    const timer = setTimeout(() => setUploadNotice(null), UPLOAD_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [uploadNotice]);
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

  const handleConfirmClose = (): void => {
    if (closeTargetId === null) return;
    const id = closeTargetId;
    setCloseTargetId(null);
    setCloseError(null);
    closeSession(id).catch((err: unknown) => setCloseError(err instanceof Error ? err.message : String(err)));
  };

  const handleConfirmRelay = (): void => {
    if (relayTargetId === null) return;
    const id = relayTargetId;
    setRelayTargetId(null);
    setRelayError(null);
    relaySession(id).catch((err: unknown) => setRelayError(err instanceof Error ? err.message : String(err)));
  };

  const handleSendPrompt = (promptId: string): void => {
    if (selectedId === null) return;
    const checkedId = selectedId;
    setQuickError(null);
    // サーバーが状態を取り直して入れてよければ本文を返す。本文は xterm の paste() で入れるだけで Enter は送らない（送るのは人が端末で Enter を押したとき）。
    // 確認している間に別のセッションへ切り替わっていたら、確認したセッションの端末ではないので何も入れない
    checkQuickPromptSend(checkedId, promptId).then(
      ({ text }) => {
        if (selectedIdRef.current !== checkedId || terminalRef.current?.pasteOnly(checkedId, text) !== true) setQuickError(t("ac.quick.switched"));
      },
      (err: unknown) => setQuickError(err instanceof Error ? err.message : String(err)),
    );
  };

  // 変更タブから送る文章を、表示中の端末へ貼って Enter を送る（端末の部品が、確認したセッションの端末だけに入れる）
  const pasteToTerminal = useCallback(
    (id: string, text: string, delayMs: number): Promise<PasteResult> => terminalRef.current?.pasteSubmitAfter(id, text, delayMs) ?? Promise.resolve("notPasted"),
    [],
  );

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
      // queued は予約しただけ。行に「予約: 名前」が出るので、10 秒の未反映の案内は付けない
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  const openResumePicker = (): void => {
    setResumeOpen(true);
    setResumeItems(null);
    setResumeError(null);
    fetchResumeTargets().then(
      (r) => setResumeItems(r.items),
      (err: unknown) => {
        setResumeItems([]);
        setResumeError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const handleResume = async (target: ResumeTarget): Promise<void> => {
    setResumeBusyPath(target.path);
    setResumeError(null);
    try {
      const { id } = await resumeSession(target);
      setSelectedId(id);
      setResumeOpen(false);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumeBusyPath(null);
    }
  };

  const handleSwitchAccount = async (): Promise<void> => {
    setAccountConfirmOpen(false);
    setAccountError(null);
    try {
      const { id } = await startAccountLogin();
      setSelectedId(id);
      setCenterTab("terminal");
    } catch (err) {
      setAccountError(err instanceof ApiError && err.status === 409 ? t("ac.account.busy") : t("ac.account.switchError"));
    }
  };

  const handleLogout = (): void => {
    void logout()
      .catch(() => undefined)
      .finally(() => setLoadFailed("unauthorized"));
  };

  useEffect(() => {
    const prev = prevStatesRef.current;
    const next = new Map<string, SessionState>();
    let loginStopped = false;
    for (const s of state?.sessions ?? []) {
      next.set(s.id, s.state);
      const before = prev.get(s.id);
      if (s.roleId === ACCOUNT_LOGIN_ROLE_ID && s.state === "stopped" && before !== "stopped") loginStopped = true;
    }
    prevStatesRef.current = next;
    if (loginStopped) setAccountRefreshKey((k) => k + 1);
  }, [state?.sessions]);

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
  if (!state) return <EmptyState title={t("ac.loading")} />;
  // 一覧から外れた（または存在しない）セッションは選択扱いにしない
  const activeId = state.sessions.some((s) => s.id === selectedId) ? selectedId : null;
  const activeSession = state.sessions.find((s) => s.id === activeId);
  const renameTarget = state.sessions.find((s) => s.id === renameTargetId);
  const closeTarget = state.sessions.find((s) => s.id === closeTargetId);
  const relayTarget = state.sessions.find((s) => s.id === relayTargetId);
  const activeRelays: RelayView[] = (state.relays ?? []).filter((r) => r.phase === "handoff" || r.phase === "launching" || r.phase === "sending");
  const relayBusyIds = new Set<string>(activeRelays.flatMap((r) => (r.newSessionId !== undefined ? [r.oldSessionId, r.newSessionId] : [r.oldSessionId])));
  const failedRelays = (state.relays ?? []).filter((r) => r.phase === "failed" && !dismissedRelays.has(r.relayId));
  const noticesKey = JSON.stringify(state.restoreNotices);
  const showNotices = state.restoreNotices.length > 0 && dismissedNotices !== noticesKey;
  const terminalNotices = state.terminalNotices ?? [];
  const terminalNoticesKey = JSON.stringify(terminalNotices);
  const showTerminalNotices = terminalNotices.length > 0 && dismissedTerminalNotices !== terminalNoticesKey;

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
          <Button variant="outline" size="sm" onClick={openResumePicker}>
            {t("ac.resumeOpen")}
          </Button>
        </div>
        {newVersion && (
          <div data-testid="new-version">
            <Callout variant="info" title={t("ac.newVersion.title")}>
              <p>{t("ac.newVersion.body")}</p>
              <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                {t("ac.newVersion.reload")}
              </Button>
            </Callout>
          </div>
        )}
        {removeError !== null && (
          <Callout variant="warning" title={t("ac.removeError")}>
            {removeError}
          </Callout>
        )}
        {closeError !== null && (
          <Callout variant="warning" title={t("ac.close.error")}>
            {closeError}
          </Callout>
        )}
        {relayError !== null && (
          <Callout variant="warning" title={t("ac.relay.error")}>
            {t("ac.relay.errorBody")}
          </Callout>
        )}
        {failedRelays.map((r) => (
          <div key={r.relayId} data-testid="relay-failed">
            <Callout variant="warning" title={t("ac.relay.failedTitle")}>
              {t(`ac.relay.failed.${r.reason ?? "start_failed"}`, { name: r.oldName })}
              <Button variant="outline" size="sm" onClick={() => setDismissedRelays((prev) => new Set(prev).add(r.relayId))}>
                {t("ac.relay.dismiss")}
              </Button>
            </Callout>
          </div>
        ))}
        {showNotices && (
          <div data-testid="restore-notices">
            <Callout variant="info" title={t("ac.restoreNotice.title")}>
              <ul>
                {state.restoreNotices.map((n, i) => (
                  <li key={`${n.reason}-${n.name ?? ""}-${i}`}>{t(`ac.restoreNotice.${n.reason}`, { name: n.name ?? "" })}</li>
                ))}
              </ul>
              <Button variant="outline" size="sm" onClick={() => setDismissedNotices(noticesKey)}>
                {t("ac.restoreNotice.dismiss")}
              </Button>
            </Callout>
          </div>
        )}
        {showTerminalNotices && (
          <div data-testid="terminal-notices">
            <Callout variant="info" title={t("ac.terminalNotice.title")}>
              <ul>
                {terminalNotices.map((n, i) => (
                  <li key={`${n.reason}-${n.name ?? ""}-${i}`}>{t(`ac.terminalNotice.${n.reason}`, { name: n.name ?? "" })}</li>
                ))}
              </ul>
              <Button variant="outline" size="sm" onClick={() => setDismissedTerminalNotices(terminalNoticesKey)}>
                {t("ac.terminalNotice.dismiss")}
              </Button>
            </Callout>
          </div>
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
          onMove={(id, toIndex) => void moveSession(id, toIndex).catch(() => undefined)}
          onRemove={handleRemove}
          relayBusyIds={relayBusyIds}
          onRelay={(id) => {
            setRelayError(null);
            setRelayTargetId(id);
          }}
          onClose={(id) => {
            setCloseError(null);
            setCloseTargetId(id);
          }}
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
        <Tabs
          variant="underline"
          size="sm"
          className="ac-center-tabs"
          activeKey={centerTab}
          onChange={setCenterTab}
          items={[
            { key: "chat", label: t("ac.tabs.chat") },
            { key: "terminal", label: t("ac.tabs.terminal") },
            { key: "changes", label: t("ac.tabs.changes"), ...(activeId !== null && diffCount !== null ? { count: diffCount } : {}) },
            { key: "files", label: t("ac.tabs.files") },
            { key: "pr", label: t("ac.tabs.pr") },
            { key: "picks", label: t("ac.tabs.picks"), ...(state.picksUnsent > 0 ? { count: state.picksUnsent } : {}) },
            { key: "routines", label: t("ac.tabs.routines") },
            { key: "reservations", label: t("ac.tabs.reservations") },
          ]}
        />
        {centerTab === "terminal" && (
          <QuickPromptBar
            prompts={quickPrompts}
            canSend={activeSession?.canChat === true}
            {...(activeSession !== undefined && activeSession.canChat !== true ? { blockedHint: t(quickBlockedKey(activeSession.state)) } : {})}
            onSend={handleSendPrompt}
            onEdit={() => setQuickEditorOpen(true)}
            onChanged={loadQuickPrompts}
          />
        )}
        {quickError !== null && (
          <Callout variant="warning" title={t("ac.quick.sendError")}>
            {quickError}
          </Callout>
        )}
        {uploadNotice !== null && (
          <Callout variant="warning" title={t("ac.upload.title")}>
            {t(`ac.upload.${uploadNotice}`, { max: `${Math.round(((state.uploadMaxBytes / BYTES_PER_MB) + Number.EPSILON) * 10) / 10} MB` })}
          </Callout>
        )}
        {/* チャットも隠すだけで外す（会話・入力欄の下書きを保つ）。セッションを切り替えたら key で作り直す */}
        <ChatPane
          key={activeId ?? "none"}
          sessionId={activeId}
          active={centerTab === "chat"}
          rev={state.activityRev}
          state={activeSession?.state ?? "unknown"}
          canChat={activeSession?.canChat === true}
          prompts={quickPrompts}
          onEditPrompts={() => setQuickEditorOpen(true)}
          onPromptsChanged={loadQuickPrompts}
          onOpenTerminal={() => setCenterTab("terminal")}
        />
        {/* 端末は隠すだけで外さない（xterm の接続を保つ）。隠し方は hidden 属性（display:none）だけ。高さ 0 などで隠すと 2 列×1 行が pty に送られる */}
        <div className="ac-page__terminal" hidden={centerTab !== "terminal"}>
          {activeId ? <TerminalPane ref={terminalRef} sessionId={activeId} smoothScrollMs={state.terminalSmoothScrollMs} uploadMaxBytes={state.uploadMaxBytes} onUploadNotice={setUploadNotice} /> : <EmptyState title={t("ac.selectSession")} />}
        </div>
        {activeId ? (
          <DiffPane
            sessionId={activeId}
            active={centerTab === "changes"}
            state={activeSession?.state ?? "unknown"}
            canInput={activeSession?.canInput === true}
            paste={pasteToTerminal}
            onCountChange={setDiffCount}
          />
        ) : (
          centerTab === "changes" && <EmptyState title={t("ac.selectSession")} />
        )}
        {activeId ? <FilesPane sessionId={activeId} active={centerTab === "files"} rev={state.activityRev} /> : centerTab === "files" && <EmptyState title={t("ac.selectSession")} />}
        {activeId ? <PrPane sessionId={activeId} active={centerTab === "pr"} /> : centerTab === "pr" && <EmptyState title={t("ac.selectSession")} />}
        {/* 部品は、セッションを選んでいなくても見られる（送るときだけ送り先が要る） */}
        <PicksPane
          sessionId={activeId}
          active={centerTab === "picks"}
          unsent={state.picksUnsent}
          state={activeSession?.state ?? "unknown"}
          canInput={activeSession?.canInput === true}
          paste={pasteToTerminal}
        />
        <RoutinesPane roles={state.roles} active={centerTab === "routines"} />
        <ReservationsPane roles={state.roles} active={centerTab === "reservations"} />
      </main>
      <aside className="ac-page__right">
        <RightPane sessionId={activeId} rev={state.activityRev} ledger={ledger} onRefresh={handleRefresh} />
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
        <AccountBadge refreshKey={accountRefreshKey} switchEnabled={state.accountSwitchEnabled} onSwitch={() => setAccountConfirmOpen(true)} />
        {accountError !== null && (
          <span className="ac-page__footer-error" data-testid="account-error">
            {accountError}
          </span>
        )}
        <UsageMeter />
        <Button variant="ghost" size="sm" onClick={() => setMemoryOpen(true)}>
          {t("ac.memory.open")}
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          {t("ac.logout")}
        </Button>
      </footer>
      <ConfirmModal
        open={closeTarget !== undefined}
        title={t("ac.close.title")}
        message={closeTarget !== undefined ? t("ac.close.body", { name: closeTarget.name }) : ""}
        confirmLabel={t("ac.close.confirm")}
        cancelLabel={t("ac.close.cancel")}
        danger
        onConfirm={handleConfirmClose}
        onCancel={() => setCloseTargetId(null)}
      />
      <ConfirmModal
        open={relayTarget !== undefined}
        title={t("ac.relay.title")}
        message={relayTarget !== undefined ? t("ac.relay.body", { name: relayTarget.name }) : ""}
        confirmLabel={t("ac.relay.confirm")}
        cancelLabel={t("ac.close.cancel")}
        onConfirm={handleConfirmRelay}
        onCancel={() => setRelayTargetId(null)}
      />
      <ConfirmModal
        open={accountConfirmOpen}
        title={t("ac.account.confirmTitle")}
        message={t("ac.account.confirmBody")}
        confirmLabel={t("ac.account.confirm")}
        cancelLabel={t("ac.account.cancel")}
        onConfirm={() => void handleSwitchAccount()}
        onCancel={() => setAccountConfirmOpen(false)}
      />
      <Modal open={renameTarget !== undefined} onClose={() => setRenameTargetId(null)} title={t("ac.rename.title")} size="sm">
        {renameTarget !== undefined && (
          <RenameForm key={renameTarget.id} session={renameTarget} busy={renameBusy} error={renameError} onSubmit={(n) => void handleRename(n)} />
        )}
      </Modal>
      <Modal open={quickEditorOpen} onClose={() => setQuickEditorOpen(false)} title={t("ac.quick.editTitle")} size="md">
        <QuickPromptEditor prompts={quickPrompts} onChanged={loadQuickPrompts} />
      </Modal>
      <Modal open={resumeOpen} onClose={() => setResumeOpen(false)} title={t("ac.resume.title")} size="lg">
        <ResumePicker items={resumeItems} busyPath={resumeBusyPath} error={resumeError} onResume={(target) => void handleResume(target)} />
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
