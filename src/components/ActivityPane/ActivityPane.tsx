import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { ProgressBar } from "@sa/components/loading/ProgressBar";
import { fetchActivity, fetchBoard } from "../../api";
import type { ActivityAgent, ActivityResponse, Board, BoardResponse, BoardRoadmapStatus } from "../../types";
import { agentLabel, formatDuration } from "./agentLabel";
import "./ActivityPane.css";

/** サーバーの写しを読み直す間隔。動いている担当などの新しい記録は WebSocket の合図（rev）でも取り直す。ボードは合図が無いので、この周期で取り直す */
const RELOAD_MS = 5000;
/** 「たった今」と書く境目（ms） */
const JUST_NOW_MS = 10_000;
const PERCENT = 100;

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";
const ROADMAP_VARIANTS: Record<BoardRoadmapStatus, BadgeVariant> = { todo: "neutral", doing: "info", done: "success" };
/** タスクの組の順（画面の上から） */
const TASK_GROUPS: BoardRoadmapStatus[] = ["doing", "todo", "done"];

type Loaded = Extract<ActivityResponse, { status: "ok" }>;
type PaneData = { kind: "data"; value: ActivityResponse } | { kind: "error" };
type BoardData = { kind: "data"; value: BoardResponse } | { kind: "error" };
interface Props {
  /** アプリのセッション id */
  sessionId: string;
  /** セッションの様子の記録の版（進んだら取り直す） */
  rev: number;
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

/**
 * 右の欄「作戦ボード」の中身。上から 動いている担当・KGI・KPI・ロードマップ（進み具合）・タスク・最近の入力。今の状態は左の一覧のバッジが正本なのでここには出さない。
 * 動いている担当と最近の入力の正本は dataDir/activity の記録、計画（KGI・KPI・ロードマップ・タスク）の正本は dataDir/boards/<会話の番号>.json。
 * ここはサーバーが返した写しを出すだけ（計画を書き込めるのは、そのセッションの Claude だけ）。
 */
export function ActivityPane({ sessionId, rev }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<PaneData | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const loadedFor = useRef<string | null>(null);
  const latestActivity = useRef(0);
  const latestBoard = useRef(0);

  const load = useCallback((id: string): void => {
    latestActivity.current += 1;
    const activitySeq = latestActivity.current;
    fetchActivity(id).then(
      (value) => {
        if (latestActivity.current === activitySeq) setData({ kind: "data", value });
      },
      () => {
        if (latestActivity.current === activitySeq) setData({ kind: "error" });
      },
    );
    latestBoard.current += 1;
    const boardSeq = latestBoard.current;
    fetchBoard(id).then(
      (value) => {
        if (latestBoard.current === boardSeq) setBoard({ kind: "data", value });
      },
      () => {
        if (latestBoard.current === boardSeq) setBoard({ kind: "error" });
      },
    );
  }, []);

  useEffect(() => {
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      setData(null);
      setBoard(null);
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

  const agentItem = (a: ActivityAgent, now: number): ReactElement => (
    <li key={a.key} className="ac-activity__agent" data-testid="activity-agent">
      <div className="ac-activity__agent-head">
        <Badge variant="info" size="sm">
          {agentLabel(a, models) || t("ac.activity.agentUnknown")}
        </Badge>
        <span className="ac-activity__muted">{t("ac.activity.runningFor", { time: time(now - a.startedAt) })}</span>
      </div>
      <p className="ac-activity__desc">{a.description !== "" ? a.description : t("ac.activity.noDescription")}</p>
    </li>
  );

  /** 「今の値 → 目標 単位」。空の値は「—」。単位が空なら単位の分の空白は付けない */
  const kpiValue = (kpi: Board["kpis"][number]): string => t("ac.board.kpiValue", { current: kpi.current || t("ac.board.noValue"), target: kpi.target || t("ac.board.noValue"), unit: kpi.unit === "" ? "" : ` ${kpi.unit}` });

  const taskRow = (item: Board["tasks"][number], index: number): ReactElement => (
    <li key={`${index}-${item.title}`} className="ac-activity__step" data-testid="board-task-item" data-status={item.status}>
      <span className="ac-activity__step-title">{item.title}</span>
    </li>
  );

  const taskGroup = (status: BoardRoadmapStatus, items: Board["tasks"]): ReactElement | null => {
    if (items.length === 0) return null;
    const heading = (
      <>
        <Badge variant={ROADMAP_VARIANTS[status]} size="sm">
          {t(`ac.board.tasksGroup.${status}`)}
        </Badge>{" "}
        <span className="ac-activity__muted">{items.length}</span>
      </>
    );
    const rows = <ul className="ac-activity__list">{items.map(taskRow)}</ul>;
    // 完了の組は <details>（SA に開閉の金型が無く、SA 本体も素の details を使う）。最初は閉じる
    return status === "done" ? (
      <details key={status} className="ac-activity__task-group" data-testid={`board-tasks-group-${status}`}>
        <summary className="ac-activity__task-summary">{heading}</summary>
        {rows}
      </details>
    ) : (
      <div key={status} className="ac-activity__task-group" data-testid={`board-tasks-group-${status}`}>
        <p className="ac-activity__task-summary">{heading}</p>
        {rows}
      </div>
    );
  };

  const tasksSection = (tasks: Board["tasks"]): ReactElement => {
    const done = tasks.filter((item) => item.status === "done").length;
    return (
      <Section id="board-tasks" title={t("ac.board.tasksTitle")}>
        {tasks.length === 0 ? (
          <p className="ac-activity__muted" data-testid="board-tasks-empty">
            {t("ac.board.tasksEmpty")}
          </p>
        ) : (
          <>
            <div data-testid="board-tasks-progress">
              <ProgressBar value={Math.round((done / tasks.length) * PERCENT)} />
            </div>
            <p className="ac-activity__muted" data-testid="board-tasks-progress-text">
              {t("ac.board.tasksProgress", { done, total: tasks.length })}
            </p>
            {TASK_GROUPS.map((status) =>
              taskGroup(
                status,
                tasks.filter((item) => item.status === status),
              ),
            )}
          </>
        )}
      </Section>
    );
  };

  const boardSections = (value: Board): ReactElement => {
    const done = value.roadmap.filter((item) => item.status === "done").length;
    const total = value.roadmap.length;
    return (
      <>
        <Section id="board-kgi" title={t("ac.board.kgiTitle")}>
          <p className="ac-activity__theme" data-testid="board-theme">
            <span className="ac-activity__muted">{t("ac.board.themeLabel")}</span> {value.theme}
          </p>
          {value.kgi.length === 0 ? (
            <p className="ac-activity__muted">{t("ac.board.emptyKgi")}</p>
          ) : (
            <ul className="ac-activity__bullets">
              {value.kgi.map((kgi, index) => (
                <li key={`${index}-${kgi.text}`} data-testid="board-kgi-item">
                  {kgi.text}
                </li>
              ))}
            </ul>
          )}
          <p className="ac-activity__muted" data-testid="board-updated">
            {t("ac.board.updated", { when: ago(Date.now() - value.updatedAt) })}
          </p>
        </Section>
        <Section id="board-kpi" title={t("ac.board.kpiTitle")}>
          {value.kpis.length === 0 ? (
            <p className="ac-activity__muted">{t("ac.board.emptyKpi")}</p>
          ) : (
            <ul className="ac-activity__list">
              {value.kpis.map((kpi, index) => (
                <li key={`${index}-${kpi.name}`} className="ac-activity__kpi" data-testid="board-kpi-item">
                  <span className="ac-activity__kpi-name" data-testid="board-kpi-name">
                    {kpi.name}
                  </span>
                  <span className="ac-activity__kpi-value" data-testid="board-kpi-value">
                    {kpiValue(kpi)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section id="board-roadmap" title={t("ac.board.roadmapTitle")}>
          {total === 0 ? (
            <p className="ac-activity__muted">{t("ac.board.emptyRoadmap")}</p>
          ) : (
            <>
              <ProgressBar value={Math.round((done / total) * PERCENT)} />
              <p className="ac-activity__muted" data-testid="board-progress-text">
                {t("ac.board.progress", { done, total })}
              </p>
              <ul className="ac-activity__list">
                {value.roadmap.map((item, index) => (
                  <li key={`${index}-${item.title}`} className="ac-activity__step" data-testid="board-roadmap-item" data-status={item.status}>
                    <Badge variant={ROADMAP_VARIANTS[item.status]} size="sm">
                      {t(`ac.board.status.${item.status}`)}
                    </Badge>
                    <span className="ac-activity__step-title">{item.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
        {tasksSection(value.tasks ?? [])}
      </>
    );
  };

  const boardArea = (): ReactNode => {
    if (board === null) return null;
    if (board.kind === "error") {
      return (
        <div data-testid="board-error">
          <Callout variant="warning" title={t("ac.board.errorTitle")}>
            {t("ac.board.errorBody")}
          </Callout>
        </div>
      );
    }
    if (board.value.status === "none") {
      return (
        <Section id="board-none" title={t("ac.board.noneTitle")}>
          <p className="ac-activity__desc">{t("ac.board.noneBody")}</p>
          <p className="ac-activity__muted">{t("ac.board.noneHint")}</p>
        </Section>
      );
    }
    if (board.value.status === "invalid") {
      return (
        <Section id="board-invalid" title={t("ac.board.invalidTitle")}>
          <p className="ac-activity__desc">{t("ac.board.invalidBody")}</p>
          <p className="ac-activity__muted">{t("ac.board.invalidHint")}</p>
        </Section>
      );
    }
    return boardSections(board.value.board);
  };

  const body = (value: Loaded): ReactElement => (
    <>
      {!value.hooks.ok && (
        <div data-testid="activity-hooks-warning">
          <Callout variant="warning" title={t("ac.activity.hooksOffTitle")}>
            {t("ac.activity.hooksOffBody")} {t("ac.activity.hooksReinstall")}
          </Callout>
        </div>
      )}
      <Section id="activity-running" title={t("ac.activity.runningTitle")}>
        {value.running.length === 0 ? <p className="ac-activity__muted">{t("ac.activity.emptyRunning")}</p> : <ul className="ac-activity__list">{value.running.map((a) => agentItem(a, value.now))}</ul>}
      </Section>
      {boardArea()}
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
