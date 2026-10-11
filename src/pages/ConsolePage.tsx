import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { Modal } from "@sa/components/Modal";
import { createSession, fetchLedger, fetchState, refreshLedger, removeSession, wsUrl } from "../api";
import { LedgerBoard } from "../components/LedgerBoard/LedgerBoard";
import { NewSessionForm, type NewSessionValues } from "../components/NewSessionForm/NewSessionForm";
import { SessionList } from "../components/SessionList/SessionList";
import { TerminalPane } from "../components/TerminalPane/TerminalPane";
import type { ConsoleState, LedgerSnapshot, SessionView } from "../types";
import "./ConsolePage.css";

const LEDGER_POLL_MS = 60000;
const RECONNECT_MS = 1000;

function useConsoleState() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    fetchState().then(setState, () => setLoadFailed(true));
    const connect = (): void => {
      ws = new WebSocket(wsUrl("/ws/events"));
      ws.onmessage = (e) => {
        const snap = JSON.parse(String(e.data)) as { sessions: SessionView[]; agentsAvailable: boolean };
        setState((prev) => (prev ? { ...prev, ...snap } : prev));
      };
      ws.onclose = () => {
        if (!closed) timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, loadFailed };
}

export function ConsolePage() {
  const { t } = useTranslation();
  const { state, loadFailed } = useConsoleState();
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

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

  if (loadFailed) return <EmptyState title={t("ac.loadError")} />;
  if (!state) return null;
  // 一覧から外れた（または存在しない）セッションは選択扱いにしない
  const activeId = state.sessions.some((s) => s.id === selectedId) ? selectedId : null;

  return (
    <div className="ac-page">
      <aside className="ac-page__left">
        <div className="ac-page__bar">
          <h1 className="ac-page__title">{t("ac.sessions")}</h1>
          <Button size="sm" onClick={() => setFormOpen(true)}>
            {t("ac.newSession")}
          </Button>
        </div>
        {removeError !== null && (
          <Callout variant="warning" title={t("ac.removeError")}>
            {removeError}
          </Callout>
        )}
        <SessionList sessions={state.sessions} roles={state.roles} selectedId={activeId} onSelect={setSelectedId} onRemove={handleRemove} />
      </aside>
      <main className="ac-page__center">
        {activeId ? <TerminalPane sessionId={activeId} /> : <EmptyState title={t("ac.selectSession")} />}
      </main>
      <aside className="ac-page__right">
        <LedgerBoard snapshot={ledger} onRefresh={handleRefresh} />
      </aside>
      <footer className="ac-page__footer" data-testid="footer">
        <span data-testid="sa-source">
          {t("ac.footer.saSource")}: {state.saSource.slice(0, 12)}
        </span>
        <span data-testid="claude-version">
          {t("ac.footer.claudeVersion")}: {state.claudeVersion}
        </span>
      </footer>
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={t("ac.newSession")} size="sm">
        <NewSessionForm roles={state.roles} busy={busy} error={formError} onSubmit={(v) => void handleCreate(v)} />
      </Modal>
    </div>
  );
}
