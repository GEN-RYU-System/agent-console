import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { CalendarView, type CalendarViewEvent } from "@sa/components/CalendarView";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { Modal } from "@sa/components/Modal";
import { Tabs } from "@sa/components/Tabs";
import { createScheduleItem, deleteScheduleItem, fetchSchedule, updateScheduleItem } from "../../api";
import type { ScheduleItem, ScheduleItemInput, ScheduleSide } from "../../types";
import { ScheduleItemEditor } from "./ScheduleItemEditor";
import { addDays, findOverlaps, firstOfMonth, jstToday, toCalendarEvents, viewRange, type ScheduleViewKind } from "./scheduleView";
import "./Schedule.css";

const POLL_MS = 60000;
const VIEW_KEY = "ac.schedule.view";
const VIEWS: ScheduleViewKind[] = ["day", "week", "month"];

function readView(): ScheduleViewKind {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "week" || v === "month" || v === "day" ? v : "day";
  } catch {
    return "day";
  }
}

function writeView(view: ScheduleViewKind): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
  }
}

const localDateOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function SchedulePane({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [side, setSide] = useState<ScheduleSide>("secretary");
  const [view, setView] = useState<ScheduleViewKind>(readView);
  const [anchor, setAnchor] = useState<string>(() => jstToday(new Date()));
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const range = useMemo(() => viewRange(view, anchor), [view, anchor]);
  const { from, to, first, dayCount } = range;

  const load = useCallback(() => void fetchSchedule(from, to).then((r) => { setItems(r.items); setLoadError(null); }, (e) => setLoadError(message(e))), [from, to]);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const changeView = (v: ScheduleViewKind): void => { setView(v); writeView(v); };
  const step = (dir: 1 | -1): void => setAnchor((a) => (view === "month" ? firstOfMonth(a, dir) : addDays(a, dir * (view === "week" ? 7 : 1))));
  const act = (run: () => Promise<unknown>): void => void run().then(() => { setActionError(null); load(); }, (e) => { setActionError(message(e)); load(); });
  const save = async (input: ScheduleItemInput): Promise<void> => { await createScheduleItem(input); setAdding(false); load(); };

  const overlaps = useMemo(() => findOverlaps(items), [items]);
  const events = useMemo(() => toCalendarEvents(items, side, overlaps.ids), [items, side, overlaps.ids]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const untimed = items.filter((i) => i.side === side && (i.date === undefined || i.start === undefined));
  const pairs = overlaps.pairs.filter(([a, b]) => a.side === side || b.side === side);
  const selected = selectedId !== null ? byId.get(selectedId) : undefined;

  const calendarDate = new Date(`${view === "month" ? first : range.first}T00:00:00`);

  const renderEvent = (ev: CalendarViewEvent, timeText: string) => {
    const item = byId.get(ev.id);
    return <div className="ac-schedule__event" data-testid="schedule-event" data-item-id={ev.id}>
      {timeText !== "" && <span>{timeText}</span>}
      <span className="ac-schedule__event-title">{ev.title}</span>
      {ev.conflict === true && <Badge variant="danger" size="sm">{t("ac.scheduleBoard.overlapBadge")}</Badge>}
      {item?.status === "done" && <Badge variant="neutral" size="sm">{t("ac.scheduleBoard.doneBadge")}</Badge>}
    </div>;
  };

  const detailTime = (i: ScheduleItem): string => [i.date, i.start !== undefined ? `${i.start}${i.end !== undefined ? `-${i.end}` : ""}` : undefined].filter(Boolean).join(" ");

  return <section className="ac-schedule" hidden={!active} data-testid="schedule-pane">
    <div className="ac-schedule__bar">
      <h2 className="ac-page__title">{t("ac.scheduleBoard.title")}</h2>
      <Tabs variant="pill" size="sm" activeKey={side} onChange={setSide} items={[{ key: "dev" as ScheduleSide, label: t("ac.scheduleBoard.sideDev") }, { key: "secretary" as ScheduleSide, label: t("ac.scheduleBoard.sideSecretary") }]} />
      <Tabs variant="pill" size="sm" activeKey={view} onChange={changeView} items={VIEWS.map((v) => ({ key: v, label: t(v === "day" ? "ac.scheduleBoard.viewDay" : v === "week" ? "ac.scheduleBoard.viewWeek" : "ac.scheduleBoard.viewMonth") }))} />
      <div className="ac-schedule__nav">
        <Button size="sm" variant="outline" onClick={() => step(-1)}>{t("ac.scheduleBoard.prev")}</Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(jstToday(new Date()))}>{t("ac.scheduleBoard.today")}</Button>
        <Button size="sm" variant="outline" onClick={() => step(1)}>{t("ac.scheduleBoard.next")}</Button>
      </div>
      <span className="ac-schedule__spacer" />
      <Button size="sm" onClick={() => setAdding(true)}>{t("ac.scheduleBoard.add")}</Button>
    </div>
    {loadError !== null && <Callout variant="warning" title={t("ac.scheduleBoard.loadFailed")}>{loadError}</Callout>}
    {actionError !== null && <Callout variant="warning" title={t("ac.scheduleBoard.saveFailed")}>{actionError}</Callout>}
    {pairs.length > 0 && <Callout variant="warning" title={t("ac.scheduleBoard.overlapTitle")}>
      <ul className="ac-schedule__pairs" data-testid="schedule-overlaps">{pairs.map(([a, b]) => <li key={`${a.id}:${b.id}`}>{t("ac.scheduleBoard.overlapPair", { a: a.title, b: b.title })}</li>)}</ul>
    </Callout>}
    <div className="ac-schedule__body">
      <div className="ac-schedule__calendar">
        <CalendarView
          key={`${view === "month" ? "month" : "days"}-${dayCount}`}
          mode={view === "month" ? "month" : "days"}
          date={calendarDate}
          dayCount={(view === "month" ? 7 : dayCount) as 2 | 7}
          events={events}
          ariaLabel={t("ac.scheduleBoard.calendarLabel")}
          renderEventContent={renderEvent}
          onEventClick={setSelectedId}
          onDayClick={(d) => { setView("day"); writeView("day"); setAnchor(localDateOf(d)); }}
        />
      </div>
      <aside className="ac-schedule__untimed" data-testid="schedule-untimed">
        <h3 className="ac-schedule__heading">{t("ac.scheduleBoard.untimed")}</h3>
        {untimed.length === 0 ? <EmptyState title={t("ac.scheduleBoard.untimedEmpty")} /> : untimed.map((i) => <div className="ac-schedule__row" key={i.id} data-testid="schedule-untimed-row">
          <div className="ac-schedule__row-head">
            <Badge variant="info" size="sm">{t(`ac.scheduleBoard.kind.${i.kind}`)}</Badge>
            <span className="ac-schedule__row-title">{i.title}</span>
            {i.status === "done" && <Badge variant="neutral" size="sm">{t("ac.scheduleBoard.doneBadge")}</Badge>}
          </div>
          <div className="ac-schedule__row-actions">
            {i.status === "open" && <Button size="sm" variant="outline" onClick={() => act(() => updateScheduleItem(i.id, { status: "done" }))}>{t("ac.scheduleBoard.markDone")}</Button>}
            <Button size="sm" variant="outline" onClick={() => act(() => deleteScheduleItem(i.id))}>{t("ac.scheduleBoard.remove")}</Button>
          </div>
        </div>)}
      </aside>
    </div>
    <Modal open={adding} onClose={() => setAdding(false)} title={t("ac.scheduleBoard.add")} size="md"><ScheduleItemEditor key={String(adding)} defaultSide={side} defaultDate={range.first} onSave={save} /></Modal>
    <Modal open={selected !== undefined} onClose={() => setSelectedId(null)} title={selected?.title ?? ""} size="sm">
      {selected && <div className="ac-schedule__detail" data-testid="schedule-detail">
        <div className="ac-schedule__row-head">
          <Badge variant="info" size="sm">{t(`ac.scheduleBoard.kind.${selected.kind}`)}</Badge>
          {selected.status === "done" && <Badge variant="neutral" size="sm">{t("ac.scheduleBoard.doneBadge")}</Badge>}
        </div>
        <div className="ac-schedule__detail-meta">{detailTime(selected)}</div>
        {selected.waitingOn !== undefined && <div className="ac-schedule__detail-meta">{t("ac.scheduleBoard.field.waitingOn")}: {selected.waitingOn}</div>}
        {selected.note !== undefined && <p className="ac-schedule__detail-note">{selected.note}</p>}
        <div className="ac-schedule__detail-actions">
          {selected.status === "open"
            ? <Button size="sm" onClick={() => { act(() => updateScheduleItem(selected.id, { status: "done" })); setSelectedId(null); }}>{t("ac.scheduleBoard.markDone")}</Button>
            : <Button size="sm" onClick={() => { act(() => updateScheduleItem(selected.id, { status: "open" })); setSelectedId(null); }}>{t("ac.scheduleBoard.reopen")}</Button>}
          <Button size="sm" variant="outline" onClick={() => { act(() => deleteScheduleItem(selected.id)); setSelectedId(null); }}>{t("ac.scheduleBoard.remove")}</Button>
        </div>
      </div>}
    </Modal>
  </section>;
}
