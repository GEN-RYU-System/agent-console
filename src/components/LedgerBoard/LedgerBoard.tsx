import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { LEDGER_COLUMNS, type LedgerSnapshot } from "../../types";
import "./LedgerBoard.css";

interface Props {
  snapshot: LedgerSnapshot | null;
  onRefresh: () => void;
}

export function LedgerBoard({ snapshot, onRefresh }: Props) {
  const { t } = useTranslation();
  const errors = snapshot?.errors ?? [];
  return (
    <section className="ac-ledger" aria-label={t("ac.ledger")}>
      <header className="ac-ledger__header">
        <h2 className="ac-ledger__title">{t("ac.ledger")}</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t("ac.ledgerRefresh")}
        </Button>
      </header>
      {errors.length > 0 && (
        <Callout variant="warning" title={t("ac.ledgerErrorTitle")}>
          <span data-testid="ledger-error">
            {t("ac.ledgerErrorBody", { count: errors.length, first: `${errors[0].branch}: ${errors[0].message}` })}
          </span>
        </Callout>
      )}
      {LEDGER_COLUMNS.map((column) => {
        const cards = snapshot?.groups[column] ?? [];
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
