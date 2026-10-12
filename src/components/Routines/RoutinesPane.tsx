import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { Modal } from "@sa/components/Modal";
import { createRoutine, fetchRoutines, setRoutineEnabled, updateRoutine } from "../../api";
import type { RoleView, Routine, RoutineInput } from "../../types";
import { RoutineEditor } from "./RoutineEditor";
import "./Routines.css";

const eventTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Tokyo",
});

export function RoutinesPane({ roles, active }: { roles: RoleView[]; active: boolean }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Routine[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | undefined>();
  const [error, setError] = useState<string | null>(null);
  const load = () => void fetchRoutines().then((r) => setItems(r.items), (e) => setError(e instanceof Error ? e.message : String(e)));
  const save = async (input: RoutineInput) => {
    const saved = editing ? await updateRoutine(editing.id, input) : await createRoutine(input);
    setItems((v) => editing ? v.map((x) => x.id === saved.id ? saved : x) : [...v, saved]);
    setOpen(false);
  };

  useEffect(() => { if (active) load(); }, [active]);

  return <section className="ac-routines" hidden={!active}>
    <div className="ac-routines__bar"><h2 className="ac-page__title">{t("ac.routines.title")}</h2><Button size="sm" onClick={() => { setEditing(undefined); setOpen(true); }}>{t("ac.routines.new")}</Button></div>
    {error && <Callout variant="warning" title={t("ac.routines.error")}>{error}</Callout>}
    <div className="ac-routines__list">
      {items.length === 0 ? <EmptyState title={t("ac.routines.empty")} /> : items.map((r) => {
        const latestEvent = r.events.at(-1);
        return <div className="ac-routines__item" key={r.id}>
          <div className="ac-routines__details">
            <strong>{r.name}</strong>
            <div className="ac-routines__meta"><span>{r.timeHHmm} JST</span><span>{latestEvent ? t(`ac.routines.outcomes.${latestEvent.outcome}`) : t("ac.routines.noEvents")}</span></div>
            <div className="ac-routines__history">
              <span className="ac-routines__history-title">{t("ac.routines.history")}</span>
              {r.events.length === 0 ? <span className="ac-routines__history-empty">{t("ac.routines.noEvents")}</span> : <ul className="ac-routines__history-list">{r.events.slice(-100).map((event) => <li className="ac-routines__history-event" key={`${event.at}-${event.slot}`}><time dateTime={new Date(event.at).toISOString()}>{eventTimeFormatter.format(event.at)}</time><Badge variant="neutral" size="sm">{t(`ac.routines.outcomes.${event.outcome}`)}</Badge></li>)}</ul>}
            </div>
          </div>
          <div className="ac-routines__meta"><Button size="sm" variant="outline" onClick={() => { setEditing(r); setOpen(true); }}>{t("ac.routines.edit")}</Button><Button size="sm" variant={r.enabled ? "primary" : "outline"} onClick={() => void setRoutineEnabled(r.id, !r.enabled).then((x) => setItems((v) => v.map((q) => q.id === x.id ? x : q)), (e) => setError(e instanceof Error ? e.message : String(e)))}>{r.enabled ? t("ac.routines.disable") : t("ac.routines.enable")}</Button></div>
        </div>;
      })}
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title={editing ? t("ac.routines.editTitle") : t("ac.routines.new")} size="md"><RoutineEditor key={editing?.id ?? "new"} routine={editing} roles={roles} onSave={save} /></Modal>
  </section>;
}
