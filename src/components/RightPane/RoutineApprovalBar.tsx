import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { fetchRoutineApproval, issueRoutineApproval } from "../../api";

/** 承認の状態を取り直す間隔 */
const RELOAD_MS = 15_000;
const MS_PER_MIN = 60_000;

interface Props {
  /** アプリのセッション id */
  sessionId: string;
}

/** ルーティンの変更を、このセッションの次の 1 回だけ通す承認ボタン。承認中は残り時間を出す */
export function RoutineApprovalBar({ sessionId }: Props) {
  const { t } = useTranslation();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetchRoutineApproval(sessionId)
      .then((r) => { setExpiresAt(r.approval === null ? null : Date.parse(r.approval.expiresAt)); setNow(Date.now()); })
      .catch(() => setExpiresAt(null));
  }, [sessionId]);
  useEffect(() => {
    setFailed(false);
    load();
    const timer = setInterval(load, RELOAD_MS);
    return () => clearInterval(timer);
  }, [load]);

  const approve = (): void => {
    setBusy(true);
    setFailed(false);
    issueRoutineApproval(sessionId)
      .then((r) => { setExpiresAt(Date.parse(r.expiresAt)); setNow(Date.now()); })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  const remaining = expiresAt !== null && expiresAt > now ? Math.max(1, Math.ceil((expiresAt - now) / MS_PER_MIN)) : null;
  return (
    <div className="ac-right__approval" data-testid="routine-approval">
      <p className="ac-right__approval-hint">{t("ac.routineApproval.hint")}</p>
      {remaining !== null ? (
        <p role="status" className="ac-right__approval-active">{t("ac.routineApproval.active", { minutes: remaining })}</p>
      ) : (
        <Button size="sm" variant="outline" onClick={approve} loading={busy}>{t("ac.routineApproval.approve")}</Button>
      )}
      {failed && <Callout variant="warning" title={t("ac.routineApproval.error")} />}
    </div>
  );
}
