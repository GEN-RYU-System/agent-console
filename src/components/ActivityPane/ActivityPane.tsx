import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Circle } from "lucide-react";
import { Badge } from "@sa/components/Badge";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { fetchActivity } from "../../api";
import type { ActivityAgent, ActivityResponse, SessionState } from "../../types";
import { STATE_LABEL_KEY } from "../StatusDot/StatusDot";
import { agentLabel, formatDuration } from "./agentLabel";
import "./ActivityPane.css";

/** サーバーの写しを読み直す間隔。新しい記録は WebSocket の合図（rev）でも取り直す */
const RELOAD_MS = 5000;
/** 「たった今」と書く境目（ms） */
const JUST_NOW_MS = 10_000;

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";
const STATE_VARIANTS: Record<SessionState, BadgeVariant> = {
  working: "info",
  waiting: "warning",
  idle: "success",
  "no-claude": "neutral",
  stopped: "neutral",
  unknown: "neutral",
};

type Loaded = Extract<ActivityResponse, { status: "ok" }>;
type PaneData = { kind: "data"; value: ActivityResponse } | { kind: "error" };

interface Props {
  /** アプリのセッション id */
  sessionId: string;
  /** セッションの様子の記録の版（進んだら取り直す） */
  rev: number;
  /** 今の状態（agents --json が正本。一覧と同じ値） */
  state: SessionState;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactElement {
  return (
    <section data-testid={id} aria-label={title}>
      <Card variant="container" density="compact" className="ac-activity__card">
        <h3 className="ac-activity__heading">{title}</h3>
        {children}
      </Card>
    </section>
  );
}

/** 右の欄「このセッション」の中身。正本は dataDir/activity の記録で、ここはサーバーがまとめた写しを出すだけ。 */
export function ActivityPane({ sessionId, rev, state }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<PaneData | null>(null);
  const loadedFor = useRef<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    (id: string): void => {
      latest.current += 1;
      const seq = latest.current;
      fetchActivity(id).then(
        (value) => {
          if (latest.current === seq) setData({ kind: "data", value });
        },
        () => {
          if (latest.current === seq) setData({ kind: "error" });
        },
      );
    },
    [],
  );

  useEffect(() => {
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      setData(null);
    }
    load(sessionId);
    const timer = setInterval(() => load(sessionId), RELOAD_MS);
    return () => clearInterval(timer);
  }, [sessionId, rev, load]);

  const models = t("ac.activity.models", { returnObjects: true }) as Record<string, string>;
  const time = (ms: number): string => {
    const { unit, count } = formatDuration(ms);
    return t(`ac.activity.unit.${unit}`, { count });
  };
  const ago = (ms: number): string => (ms < JUST_NOW_MS ? t("ac.activity.justNow") : t("ac.activity.ago", { time: time(ms) }));

  const agentItem = (a: ActivityAgent, now: number, running: boolean): ReactElement => {
    const label = agentLabel(a, models) || t("ac.activity.agentUnknown");
    const clock = running
      ? a.startedAt !== null
        ? t("ac.activity.runningFor", { time: time(now - a.startedAt) })
        : ""
      : a.durationMs !== null
        ? t("ac.activity.took", { time: time(a.durationMs) })
        : "";
    const endedAgo = !running && a.endedAt !== null ? ago(now - a.endedAt) : "";
    return (
      <li key={a.key} className="ac-activity__agent" data-testid="activity-agent">
        <div className="ac-activity__agent-head">
          <Badge variant={running ? "info" : "neutral"} size="sm">
            {label}
          </Badge>
          {clock !== "" && <span className="ac-activity__muted">{clock}</span>}
          {endedAgo !== "" && <span className="ac-activity__muted">{endedAgo}</span>}
        </div>
        <p className="ac-activity__desc">{a.description !== "" ? a.description : t("ac.activity.noDescription")}</p>
        {a.summary !== "" && <p className="ac-activity__summary">{a.summary}</p>}
      </li>
    );
  };

  const stateSection = (
    <Section id="activity-state" title={t("ac.activity.stateTitle")}>
      <Badge variant={STATE_VARIANTS[state]} size="sm">
        {t(STATE_LABEL_KEY[state])}
      </Badge>
    </Section>
  );

  const body = (value: Loaded): ReactElement => (
    <>
      {!value.hooks.ok && (
        <div data-testid="activity-hooks-warning">
          <Callout variant="warning" title={t("ac.activity.hooksOffTitle")}>
            {t("ac.activity.hooksOffBody")}
          </Callout>
        </div>
      )}
      {stateSection}
      <Section id="activity-running" title={t("ac.activity.runningTitle")}>
        {value.running.length === 0 ? <p className="ac-activity__muted">{t("ac.activity.emptyRunning")}</p> : <ul className="ac-activity__list">{value.running.map((a) => agentItem(a, value.now, true))}</ul>}
      </Section>
      <Section id="activity-finished" title={t("ac.activity.finishedTitle")}>
        {value.finished.length === 0 ? <p className="ac-activity__muted">{t("ac.activity.emptyFinished")}</p> : <ul className="ac-activity__list">{value.finished.map((a) => agentItem(a, value.now, false))}</ul>}
      </Section>
      <Section id="activity-tasks" title={t("ac.activity.tasksTitle")}>
        {value.tasks.length === 0 ? (
          <p className="ac-activity__muted">{t("ac.activity.emptyTasks")}</p>
        ) : (
          <ul className="ac-activity__list">
            {value.tasks.map((task) => (
              <li key={task.id} className="ac-activity__task" data-testid="activity-task" data-done={task.done} title={task.done ? t("ac.activity.taskDone") : t("ac.activity.taskOpen")}>
                {task.done ? <Check className="ac-activity__mark ac-activity__mark--done" aria-hidden="true" /> : <Circle className="ac-activity__mark" aria-hidden="true" />}
                <span>{task.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="activity-inputs" title={t("ac.activity.inputsTitle")}>
        {value.inputs.length === 0 ? (
          <p className="ac-activity__muted">{t("ac.activity.emptyInputs")}</p>
        ) : (
          <ul className="ac-activity__list">
            {value.inputs.map((input) => (
              <li key={`${input.ts}-${input.text}`} className="ac-activity__input" data-testid="activity-input">
                <span className="ac-activity__input-text">{input.text}</span>
                <span className="ac-activity__muted">{ago(value.now - input.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );

  const content = (): ReactElement => {
    if (data === null) return <EmptyState size="compact" title={t("ac.activity.loading")} />;
    if (data.kind === "error") {
      return (
        <div data-testid="activity-error">
          <Callout variant="warning" title={t("ac.activity.errorTitle")}>
            {t("ac.activity.errorBody")}
          </Callout>
        </div>
      );
    }
    if (data.value.status === "noSession") {
      return (
        <div data-testid="activity-no-session">
          <EmptyState size="compact" title={t("ac.activity.noSessionTitle")} description={t("ac.activity.noSessionHint")} />
        </div>
      );
    }
    return body(data.value);
  };

  return (
    <div className="ac-activity" data-testid="activity-pane">
      {content()}
    </div>
  );
}
