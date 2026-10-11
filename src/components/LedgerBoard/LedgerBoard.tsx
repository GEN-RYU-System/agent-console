import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Card } from "@sa/components/Card";
import { LEDGER_COLUMNS, type LedgerGroups } from "../../types";
import "./LedgerBoard.css";

interface Props {
  groups: LedgerGroups | null;
  onRefresh: () => void;
}

export function LedgerBoard({ groups, onRefresh }: Props) {
  const { t } = useTranslation();
  return (
    <section className="ac-ledger" aria-label={t("ac.ledger")}>
      <header className="ac-ledger__header">
        <h2 className="ac-ledger__title">{t("ac.ledger")}</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t("ac.ledgerRefresh")}
        </Button>
      </header>
      {LEDGER_COLUMNS.map((column) => {
        const cards = groups?.[column] ?? [];
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
