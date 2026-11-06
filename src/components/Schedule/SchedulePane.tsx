import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { findOverlaps, jstToday, shiftAnchor, toCalendarEvents, viewRange, type ScheduleViewMode } from "./scheduleView";
import "./Schedule.css";

const POLL_MS = 60000;
const VIEW_KEY = "ac.schedule.view";
const VIEWS: ScheduleViewMode[] = ["day", "week", "month"];

function readView(): ScheduleViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(v as ScheduleViewMode) ? (v as ScheduleViewMode) : "day";
  } catch {
    return "day";
  }
}

const localDateKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function SchedulePane({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [side, setSide] = useState<ScheduleSide>("secretary");
  const [view, setViewState] = useState<ScheduleViewMode>(readView);
  const [anchor, setAnchor] = useState<string>(() => jstToday(new Date()));
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const seq = useRef(0);

  const range = useMemo(() => viewRange(view, anchor), [view, anchor]);
  const setView = (v: ScheduleViewMode): void => {
    setViewState(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { return; }
  };

  const load = useCallback(() => {
    const mine = ++seq.current;
    void fetchSchedule(range.from, range.to).then(
      (r) => { if (mine === seq.current) { setItems(r.items); setLoadError(null); } },
      (e) => { if (mine === seq.current) setLoadError(errorText(e)); },
    );
  }, [range.from, range.to]);

  // タブが開いている間だけ、開いたとき・範囲が変わったとき・60 秒ごとに取り直す
  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const overlaps = useMemo(() => findOverlaps(items), [items]);
  const events = useMemo(() => toCalendarEvents(items, side, overlaps.ids), [items, side, overlaps]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const untimed = items.filter((i) => i.side === side && (i.date === undefined || i.start === undefined));
  const pairs = overlaps.pairs.filter(([a, b]) => a.side === side || b.side === side);
  const selected = selectedId === null ? undefined : byId.get(selectedId);

  const run = (job: Promise<unknown>): void => {
    setActionError(null);
    void job.then(() => { setSelectedId(null); load(); }, (e) => { setActionError(errorText(e)); load(); });
  };
  const markDone = (id: string): void => run(updateScheduleItem(id, { status: "done" }));
  const reopen = (id: string): void => run(updateScheduleItem(id, { status: "open" }));
  const remove = (id: string): void => run(deleteScheduleItem(id));
  const add = async (input: ScheduleItemInput): Promise<void> => {
    await createScheduleItem(input);
    setAdding(false);
    load();
  };
  const openDay = (d: Date): void => { setAnchor(localDateKey(d)); setView("day"); };

  const renderContent = (event: CalendarViewEvent, timeText: string) => {
    const item = byId.get(event.id);
    return <div className="ac-schedule__event" data-testid="schedule-event" data-item-id={event.id}>
      {timeText !== "" && <span className="ac-schedule__time">{timeText}</span>}
      <span className="ac-schedule__title">{event.title}</span>
      {event.conflict === true && <Badge variant="danger" size="sm">{t("ac.scheduleBoard.overlapBadge")}</Badge>}
      {item?.status === "done" && <Badge variant="neutral" size="sm">{t("ac.scheduleBoard.doneBadge")}</Badge>}
    </div>;
  };

  const when = (i: ScheduleItem): string => [i.date, i.start === undefined ? undefined : `${i.start}${i.end === undefined ? "" : `〜${i.end}`}`].filter(Boolean).join(" ");

  return <section className="ac-schedule" hidden={!active} data-testid="schedule-pane">
    <div className="ac-schedule__bar">
      <Tabs variant="pill" size="sm" activeKey={side} onChange={setSide} items={[{ key: "dev" as ScheduleSide, label: t("ac.scheduleBoard.sideDev") }, { key: "secretary" as ScheduleSide, label: t("ac.scheduleBoard.sideSecretary") }]} />
      <Tabs variant="pill" size="sm" activeKey={view} onChange={setView} items={[{ key: "day" as ScheduleViewMode, label: t("ac.scheduleBoard.viewDay") }, { key: "week" as ScheduleViewMode, label: t("ac.scheduleBoard.viewWeek") }, { key: "month" as ScheduleViewMode, label: t("ac.scheduleBoard.viewMonth") }]} />
      <div className="ac-schedule__nav">
        <Button size="sm" variant="outline" onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}>{t("ac.scheduleBoard.prev")}</Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(jstToday(new Date()))}>{t("ac.scheduleBoard.today")}</Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}>{t("ac.scheduleBoard.next")}</Button>
      </div>
      <Button size="sm" onClick={() => setAdding(true)}>{t("ac.scheduleBoard.add")}</Button>
    </div>
    {loadError !== null && <Callout variant="warning" title={t("ac.scheduleBoard.loadFailed")}>{loadError}</Callout>}
    {pairs.length > 0 && <Callout variant="danger" title={t("ac.scheduleBoard.overlapTitle")}>
      <ul className="ac-schedule__pairs" data-testid="schedule-overlaps">{pairs.map(([a, b]) => <li key={`${a.id}:${b.id}`}>{t("ac.scheduleBoard.overlapPair", { a: a.title, b: b.title })}</li>)}</ul>
    </Callout>}
    <div className="ac-schedule__body">
      <div className="ac-schedule__main">
        <CalendarView
          mode={view === "month" ? "month" : "days"}
          date={`${range.first}T00:00:00`}
          {...(view === "month" ? {} : { dayCount: range.dayCount })}
          events={events}
          ariaLabel={t("ac.scheduleBoard.calendarLabel")}
          renderEventContent={renderContent}
          onEventClick={(id) => { setActionError(null); setSelectedId(id); }}
          onDayClick={openDay}
        />
      </div>
      <aside className="ac-schedule__untimed" data-testid="schedule-untimed">
        <h3 className="ac-schedule__heading">{t("ac.scheduleBoard.untimed")}</h3>
        {untimed.length === 0 ? <EmptyState size="compact" title={t("ac.scheduleBoard.untimedEmpty")} /> : <div className="ac-schedule__list">{untimed.map((i) => <div className="ac-schedule__row" key={i.id} data-testid="schedule-untimed-row">
          <Badge variant="info" size="sm">{t(`ac.scheduleBoard.kind.${i.kind}`)}</Badge>
          <span className="ac-schedule__title">{i.title}</span>
          {i.status === "done" ? <Badge variant="neutral" size="sm">{t("ac.scheduleBoard.doneBadge")}</Badge> : <Button size="sm" variant="outline" onClick={() => markDone(i.id)}>{t("ac.scheduleBoard.markDone")}</Button>}
          <Button size="sm" variant="outline" onClick={() => remove(i.id)}>{t("ac.scheduleBoard.remove")}</Button>
        </div>)}</div>}
      </aside>
    </div>
    <Modal open={adding} onClose={() => setAdding(false)} title={t("ac.scheduleBoard.add")} size="md"><ScheduleItemEditor key={String(adding)} defaultSide={side} defaultDate={range.first} onSave={add} /></Modal>
    <Modal open={selected !== undefined} onClose={() => setSelectedId(null)} title={selected?.title ?? ""} size="sm">
      {selected !== undefined && <div className="ac-schedule__detail" data-testid="schedule-detail">
        <div className="ac-schedule__meta"><Badge variant="info" size="sm">{t(`ac.scheduleBoard.kind.${selected.kind}`)}</Badge><span>{when(selected)}</span></div>
        {selected.waitingOn !== undefined && <div className="ac-schedule__meta">{t("ac.scheduleBoard.field.waitingOn")}: {selected.waitingOn}</div>}
        {selected.note !== undefined && <p className="ac-schedule__note">{selected.note}</p>}
        {actionError !== null && <Callout variant="warning" title={t("ac.scheduleBoard.saveFailed")}>{actionError}</Callout>}
        <div className="ac-schedule__actions">
          {selected.status === "open" ? <Button size="sm" onClick={() => markDone(selected.id)}>{t("ac.scheduleBoard.markDone")}</Button> : <Button size="sm" onClick={() => reopen(selected.id)}>{t("ac.scheduleBoard.reopen")}</Button>}
          <Button size="sm" variant="outline" onClick={() => remove(selected.id)}>{t("ac.scheduleBoard.remove")}</Button>
        </div>
      </div>}
    </Modal>
  </section>;
}
