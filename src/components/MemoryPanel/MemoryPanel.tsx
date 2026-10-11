import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Callout } from "@sa/components/Callout";
import { Stack } from "@sa/components/Stack";
import { ProgressBar } from "@sa/components/loading/ProgressBar";
import { fetchMemory } from "../../api";
import type { MemorySnapshot } from "../../types";
import "./MemoryPanel.css";

export const MEMORY_REFRESH_MS = 10000;
const PERCENT = 100;

/** 物理メモリに対する割合（%・整数）。棒グラフ（ProgressBar は整数に丸めて表示する）と文字で同じ値にそろえる。合計が不明なら null。 */
export function percentOf(mb: number, totalMb: number | null): number | null {
  return totalMb === null || totalMb <= 0 ? null : Math.round((mb / totalMb) * PERCENT);
}

interface Props {
  /** 開いている間だけ 10 秒ごとに読み直す（閉じたら止める） */
  open: boolean;
}

export function MemoryPanel({ open }: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let closed = false;
    const load = (): void => {
      fetchMemory().then(
        (s) => {
          if (closed) return;
          setSnapshot(s);
          setFailed(false);
        },
        () => !closed && setFailed(true),
      );
    };
    load();
    const timer = setInterval(load, MEMORY_REFRESH_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [open]);

  if (failed && snapshot === null) return <Callout variant="warning" title={t("ac.memory.error")}>{t("ac.memory.errorBody")}</Callout>;
  if (snapshot === null) return <span className="ac-memory__muted">{t("ac.memory.loading")}</span>;
  const total = snapshot.system?.totalMb ?? null;
  const serverPct = percentOf(snapshot.serverRssMb, total);
  return (
    <Stack gap="4">
      <section data-testid="memory-system" className="ac-memory__block">
        <h3 className="ac-memory__heading">{t("ac.memory.system")}</h3>
        {snapshot.system ? (
          <>
            <ProgressBar value={snapshot.system.usedPercent} label={t("ac.memory.systemUsed", { percent: snapshot.system.usedPercent })} />
            <span className="ac-memory__muted" data-testid="memory-system-detail">
              {t("ac.memory.systemDetail", { total: snapshot.system.totalMb, free: snapshot.system.freePercent })}
            </span>
          </>
        ) : (
          <span className="ac-memory__muted">{t("ac.memory.systemUnknown")}</span>
        )}
      </section>
      <section data-testid="memory-server" className="ac-memory__block">
        <h3 className="ac-memory__heading">{t("ac.memory.server")}</h3>
        <span className="ac-memory__value">
          {t("ac.memory.value", { mb: snapshot.serverRssMb, percent: serverPct ?? "-" })}
        </span>
      </section>
      <section className="ac-memory__block">
        <h3 className="ac-memory__heading">{t("ac.memory.sessions")}</h3>
        {snapshot.sessions.length === 0 && <span className="ac-memory__muted">{t("ac.memory.noSessions")}</span>}
        {snapshot.sessions.map((s) => {
          const pct = percentOf(s.rssMb, total);
          return (
            <div key={s.id} className="ac-memory__session" data-testid={`memory-session-${s.id}`} data-rss-mb={s.rssMb}>
              <ProgressBar value={pct ?? 0} label={s.name} />
              <span className="ac-memory__value">{t("ac.memory.value", { mb: s.rssMb, percent: pct ?? "-" })}</span>
            </div>
          );
        })}
      </section>
    </Stack>
  );
}
