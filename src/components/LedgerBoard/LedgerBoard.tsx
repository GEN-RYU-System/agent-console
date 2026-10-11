import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { Select } from "@sa/components/Select";
import { TextField } from "@sa/components/TextField";
import { LEDGER_COLUMNS, type LedgerSnapshot } from "../../types";
import {
  applyLedgerFilter,
  LEDGER_PERIODS,
  LEDGER_STATE_FILTERS,
  loadLedgerFilter,
  saveLedgerFilter,
  type LedgerFilter,
  type LedgerPeriod,
  type LedgerStateFilter,
} from "./ledgerFilter";
import "./LedgerBoard.css";

interface Props {
  snapshot: LedgerSnapshot | null;
  onRefresh: () => void;
  /** 期間の判定に使う現在時刻（テスト用。既定は Date.now()） */
  now?: number;
}

const periodKey = (p: LedgerPeriod): string => (p === "all" ? "ac.ledgerFilter.periodAll" : `ac.ledgerFilter.period${p}`);

export function LedgerBoard({ snapshot, onRefresh, now }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<LedgerFilter>(loadLedgerFilter);
  const errors = snapshot?.errors ?? [];
  const filtered = useMemo(() => applyLedgerFilter(snapshot, filter, now ?? Date.now()), [snapshot, filter, now]);

  const update = (next: LedgerFilter): void => {
    setFilter(next);
    saveLedgerFilter(next);
  };

  return (
    <section className="ac-ledger" aria-label={t("ac.ledger")}>
      <header className="ac-ledger__header">
        <h2 className="ac-ledger__title">{t("ac.ledger")}</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t("ac.ledgerRefresh")}
        </Button>
      </header>
      <div className="ac-ledger__filters" data-testid="ledger-filters">
        <Select
          size="sm"
          label={t("ac.ledgerFilter.period")}
          value={filter.period}
          onChange={(e) => update({ ...filter, period: e.target.value as LedgerPeriod })}
          options={LEDGER_PERIODS.map((p) => ({ value: p, label: t(periodKey(p)) }))}
          fullWidth
        />
        <Select
          size="sm"
          label={t("ac.ledgerFilter.state")}
          value={filter.state}
          onChange={(e) => update({ ...filter, state: e.target.value as LedgerStateFilter })}
          options={LEDGER_STATE_FILTERS.map((s) => ({ value: s, label: t(`ac.ledgerFilter.state_${s}`) }))}
          fullWidth
        />
        <TextField
          size="sm"
          label={t("ac.ledgerFilter.search")}
          value={filter.query}
          onChange={(e) => update({ ...filter, query: e.target.value })}
          fullWidth
        />
      </div>
      <div className="ac-ledger__summary" data-testid="ledger-summary" data-shown={filtered.shown} data-hidden={filtered.hidden} data-unknown={filtered.unknownDate}>
        <span>{t("ac.ledgerFilter.summary", { shown: filtered.shown, hidden: filtered.hidden })}</span>
        {filtered.unknownDate > 0 && <span data-testid="ledger-unknown-date">{t("ac.ledgerFilter.unknownDate", { count: filtered.unknownDate })}</span>}
      </div>
      {errors.length > 0 && (
        <Callout variant="warning" title={t("ac.ledgerErrorTitle")}>
          <span data-testid="ledger-error">
            {t("ac.ledgerErrorBody", { count: errors.length, first: `${errors[0].branch}: ${errors[0].message}` })}
          </span>
        </Callout>
      )}
      {LEDGER_COLUMNS.map((column) => {
        const cards = filtered.groups[column];
        return (
          <div key={column} className="ac-ledger__column" data-testid={`ledger-col-${column}`} data-count={cards.length}>
            <div className="ac-ledger__column-head">
              <span className="ac-ledger__column-title">{t(`ac.column.${column}`)}</span>
              <Badge variant={column === "UNREGISTERED" ? "warning" : "neutral"}>{String(cards.length)}</Badge>
            </div>
            {cards.length === 0 ? (
              <span className="ac-ledger__empty">{t("ac.ledgerEmpty")}</span>
            ) : (
              cards.map((card) => (
                <Card key={card.branch} density="compact" data-testid="ledger-card">
                  <span className="ac-ledger__branch">{card.branch}</span>
                </Card>
              ))
            )}
          </div>
        );
      })}
    </section>
  );
}
