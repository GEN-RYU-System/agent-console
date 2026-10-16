import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { ProgressBar } from "@sa/components/loading/ProgressBar";
import { fetchMemory } from "../../api";
import type { MemorySnapshot } from "../../types";
import { usageLevel } from "../UsageMeter/usageLogic";
import { MEMORY_REFRESH_MS } from "../MemoryPanel/MemoryPanel";
import "./MacMeter.css";

type MeterKey = "cpu" | "ram" | "disk";

/** 取得した値から 3 本分の使用率（%）。まだ測れていないものは null */
export function meterValues(snapshot: MemorySnapshot | null): Record<MeterKey, number | null> {
  const system = snapshot?.system ?? null;
  return { cpu: system?.cpuPercent ?? null, ram: system?.usedPercent ?? null, disk: system?.diskUsedPercent ?? null };
}

function MeterRow({ id, value }: { id: MeterKey; value: number | null }) {
  const { t } = useTranslation();
  const level = value === null ? "normal" : usageLevel(value);
  return (
    <div className="ac-macmeter__row" data-testid={`mac-meter-${id}`}>
      <span className="ac-macmeter__label">{t(`ac.macMeter.${id}`)}</span>
      {value === null ? (
        <span className="ac-macmeter__text" data-testid={`mac-meter-measuring-${id}`}>
          {t("ac.macMeter.measuring")}
        </span>
      ) : (
        <>
          {/* 100% 以上は UsageMeter と同じく ProgressBar を出さず danger の Badge */}
          {level !== "full" && (
            <div className="ac-macmeter__bar" data-testid={`mac-meter-bar-${id}`}>
              <ProgressBar value={value} variant="linear" />
            </div>
          )}
          <span className="ac-macmeter__pct" data-testid={`mac-meter-pct-${id}`}>
            {t("ac.macMeter.percent", { percent: Math.round(value) })}
          </span>
          {level === "full" && (
            <span data-testid={`mac-meter-badge-${id}`} data-level={level}>
              <Badge variant="danger" size="sm">
                {t("ac.usage.atLimit")}
              </Badge>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** 下の帯の右端に出す、この Mac の CPU・RAM・Disk の 3 本のバー。/api/memory（サーバーが 2 秒ごとに測った値）を 2 秒ごとに取り直す */
export function MacMeter() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let closed = false;
    const load = (): void => {
      fetchMemory().then(
        (s) => {
          if (closed) return;
          setSnapshot(s);
          setFailed(false);
        },
        () => {
          if (!closed) setFailed(true);
        },
      );
    };
    load();
    const timer = setInterval(load, MEMORY_REFRESH_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  const values = meterValues(snapshot);
  return (
    <div className="ac-macmeter" data-testid="mac-meter">
      <span className="ac-macmeter__title">{t("ac.macMeter.title")}</span>
      {failed ? (
        <span className="ac-macmeter__text" data-testid="mac-meter-message">
          {t("ac.macMeter.error")}
        </span>
      ) : (
        (["cpu", "ram", "disk"] as const).map((id) => <MeterRow key={id} id={id} value={values[id]} />)
      )}
    </div>
  );
}
