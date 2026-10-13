import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { ProgressBar } from "@sa/components/loading/ProgressBar";
import { fetchUsage } from "../../api";
import type { UsageResponse, UsageWindow } from "../../types";
import { USAGE_REFRESH_MS, isWindowReset, minutesSince, resetParts, usageLevel, type UsageLevel } from "./usageLogic";
import "./UsageMeter.css";

type WindowKey = "week" | "fiveHour";

const LEVEL_BADGE: Record<Exclude<UsageLevel, "normal">, { variant: "warning" | "danger"; labelKey: string }> = {
  warning: { variant: "warning", labelKey: "ac.usage.nearLimit" },
  danger: { variant: "danger", labelKey: "ac.usage.almostLimit" },
  full: { variant: "danger", labelKey: "ac.usage.atLimit" },
};

interface WindowProps {
  id: WindowKey;
  window: UsageWindow;
  nowMs: number;
}

function UsageWindowRow({ id, window: w, nowMs }: WindowProps) {
  const { t } = useTranslation();
  const label = t(id === "week" ? "ac.usage.week" : "ac.usage.fiveHour");
  if (isWindowReset(w, nowMs)) {
    return (
      <div className="ac-usage__win" data-testid={`usage-meter-${id}`}>
        <span className="ac-usage__label">{label}</span>
        <span className="ac-usage__text" data-testid={`usage-meter-reset-done-${id}`}>
          {t("ac.usage.resetDone")}
        </span>
      </div>
    );
  }
  const level = usageLevel(w.usedPercentage);
  const badge = level === "normal" ? null : LEVEL_BADGE[level];
  return (
    <div className="ac-usage__win" data-testid={`usage-meter-${id}`}>
      <span className="ac-usage__label">{label}</span>
      {/* 100% 以上は ProgressBar を出さない（完了の見た目になるため）。代わりに danger の Badge */}
      {level !== "full" && (
        <div className="ac-usage__bar" data-testid={`usage-meter-bar-${id}`}>
          <ProgressBar value={w.usedPercentage} variant="linear" />
        </div>
      )}
      <span className="ac-usage__pct" data-testid={`usage-meter-pct-${id}`}>
        {t("ac.usage.percent", { percent: Math.round(w.usedPercentage) })}
      </span>
      {badge !== null && (
        <span data-testid={`usage-meter-badge-${id}`} data-level={level}>
          <Badge variant={badge.variant} size="sm">
            {t(badge.labelKey)}
          </Badge>
        </span>
      )}
      <span className="ac-usage__text">{t("ac.usage.resetAt", resetParts(w.resetsAt))}</span>
    </div>
  );
}

/** 下の帯に出す、Claude の利用量（週・5 時間）の 2 本のバー。60 秒ごとに取り直す（サーバーはファイルを読むだけ） */
export function UsageMeter() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let closed = false;
    const load = (): void => {
      fetchUsage().then(
        (u) => {
          if (closed) return;
          setUsage(u);
          setFailed(false);
          setNowMs(Date.now());
        },
        () => {
          if (closed) return;
          setFailed(true);
          setNowMs(Date.now());
        },
      );
    };
    load();
    const timer = setInterval(load, USAGE_REFRESH_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  if (failed) {
    return (
      <div className="ac-usage" data-testid="usage-meter">
        <span className="ac-usage__text" data-testid="usage-meter-message">
          {t("ac.usage.error")}
        </span>
      </div>
    );
  }
  if (usage === null) return <div className="ac-usage" data-testid="usage-meter" />;
  if (usage.status !== "ok") {
    return (
      <div className="ac-usage" data-testid="usage-meter">
        <span className="ac-usage__text" data-testid="usage-meter-message">
          {t(usage.status === "none" ? "ac.usage.none" : "ac.usage.invalid")}
        </span>
      </div>
    );
  }
  const minutes = minutesSince(usage.observedAt, nowMs);
  return (
    <div className="ac-usage" data-testid="usage-meter">
      {usage.sevenDay && <UsageWindowRow id="week" window={usage.sevenDay} nowMs={nowMs} />}
      {usage.fiveHour && <UsageWindowRow id="fiveHour" window={usage.fiveHour} nowMs={nowMs} />}
      <span className="ac-usage__text" data-testid="usage-meter-age">
        {minutes === 0 ? t("ac.usage.justNow") : t("ac.usage.minutesAgo", { minutes })}
      </span>
    </div>
  );
}
