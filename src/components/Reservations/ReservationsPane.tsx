import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, type BadgeVariant } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { Modal } from "@sa/components/Modal";
import { cancelReservation, createReservation, fetchReservations } from "../../api";
import type { Reservation, ReservationInput, RoleView } from "../../types";
import { ReservationEditor } from "./ReservationEditor";
import { formatJst } from "./formatJst";
import "./Reservations.css";

const POLL_MS = 10000;

const finishedAt = (r: Reservation): number => r.finishedAt ?? r.updatedAt;

function statusView(r: Reservation, t: (key: string, opts?: Record<string, unknown>) => string): { label: string; variant: BadgeVariant } {
  if (r.status === "pending") return { label: t("ac.reservations.status.pending"), variant: "info" };
  if (r.status === "dispatching") return { label: t("ac.reservations.status.dispatching"), variant: "warning" };
  if (r.status === "cancelled") return { label: t("ac.reservations.status.cancelled"), variant: "neutral" };
  if (r.outcome === "sent") return r.lateMinutes !== undefined ? { label: t("ac.reservations.status.late", { minutes: r.lateMinutes }), variant: "warning" } : { label: t("ac.reservations.status.sent"), variant: "success" };
  return { label: t(`ac.reservations.outcomes.${r.outcome ?? "failed"}`), variant: "danger" };
}

export function ReservationsPane({ roles, active }: { roles: RoleView[]; active: boolean }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Reservation[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void fetchReservations().then((r) => setItems(r.items), (e) => setError(e instanceof Error ? e.message : String(e))), []);
  const save = async (input: ReservationInput): Promise<void> => {
    await createReservation(input);
    setOpen(false);
    load();
  };
  const cancel = (id: string): void => void cancelReservation(id).then(load, (e) => { setError(e instanceof Error ? e.message : String(e)); load(); });

  // タブが開いている間だけ、開いたとき・10 秒ごとに取り直す（AI が登録したものを表示するため）
  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const upcoming = items.filter((r) => r.status === "pending" || r.status === "dispatching").sort((a, b) => a.runAt - b.runAt);
  const finished = items.filter((r) => r.status === "done" || r.status === "cancelled").sort((a, b) => finishedAt(b) - finishedAt(a));

  const row = (r: Reservation) => {
    const view = statusView(r, t);
    return <div className="ac-reservations__item" key={r.id} data-testid="reservation-row">
      <div className="ac-reservations__details">
        <strong>{r.name}</strong>
        <div className="ac-reservations__meta">
          <time dateTime={r.runAtJst}>{formatJst(r.runAtJst)}</time>
          <span>{t(roles.find((x) => x.id === r.roleId)?.labelKey ?? r.roleId)}</span>
          <span>{r.createdBy === "agent" ? t("ac.reservations.byAgent") : t("ac.reservations.byUi")}</span>
          <Badge variant={view.variant} size="sm">{view.label}</Badge>
        </div>
        {r.measureNote !== undefined && <div className="ac-reservations__note">{t("ac.reservations.measureNote", { note: r.measureNote })}</div>}
      </div>
      {r.status === "pending" && <Button size="sm" variant="outline" onClick={() => cancel(r.id)}>{t("ac.reservations.cancel")}</Button>}
    </div>;
  };

  return <section className="ac-reservations" hidden={!active} data-testid="reservations-pane">
    <div className="ac-reservations__bar"><h2 className="ac-page__title">{t("ac.reservations.title")}</h2><Button size="sm" onClick={() => setOpen(true)}>{t("ac.reservations.new")}</Button></div>
    {error && <Callout variant="warning" title={t("ac.reservations.error")}>{error}</Callout>}
    <div className="ac-reservations__section">
      <h3 className="ac-reservations__heading">{t("ac.reservations.upcoming")}</h3>
      {upcoming.length === 0 ? <EmptyState title={t("ac.reservations.emptyUpcoming")} /> : <div className="ac-reservations__list">{upcoming.map(row)}</div>}
    </div>
    <div className="ac-reservations__section">
      <h3 className="ac-reservations__heading">{t("ac.reservations.finished")}</h3>
      {finished.length === 0 ? <EmptyState title={t("ac.reservations.emptyFinished")} /> : <div className="ac-reservations__list">{finished.map(row)}</div>}
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title={t("ac.reservations.new")} size="md"><ReservationEditor key={String(open)} roles={roles} onSave={save} /></Modal>
  </section>;
}
