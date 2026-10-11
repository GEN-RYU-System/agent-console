import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { Stack } from "@sa/components/Stack";
import type { PastSession } from "../../types";
import "./PastSessions.css";

interface Props {
  /** null: 読み込み中 */
  items: PastSession[] | null;
  available: boolean;
  canResume: boolean;
  busyId: string | null;
  error: string | null;
  onResume: (sessionId: string) => void;
}

const formatStartedAt = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toLocaleString("ja-JP"));

/** 正本は `claude agents --all --json`。アプリは保存しない。 */
export function PastSessionsList({ items, available, canResume, busyId, error, onResume }: Props) {
  const { t } = useTranslation();
  if (items === null) return <span className="ac-past__muted">{t("ac.past.loading")}</span>;
  return (
    <Stack gap="3">
      {!available && (
        <Callout variant="warning" title={t("ac.past.unavailableTitle")}>
          {t("ac.past.unavailableBody")}
        </Callout>
      )}
      {!canResume && available && <Callout variant="info" title={t("ac.past.noRoleTitle")}>{t("ac.past.noRoleBody")}</Callout>}
      {error !== null && (
        <Callout variant="warning" title={t("ac.past.error")}>
          {error}
        </Callout>
      )}
      {items.length === 0 ? (
        <EmptyState size="compact" title={t("ac.past.empty")} />
      ) : (
        items.map((p) => (
          <Card key={p.sessionId} density="compact" data-testid="past-session" data-session-id={p.sessionId}>
            <div className="ac-past__row">
              <div className="ac-past__text">
                <span className="ac-past__name">{p.name}</span>
                <span className="ac-past__muted">{p.cwd}</span>
                <span className="ac-past__muted">{formatStartedAt(p.startedAt)}</span>
              </div>
              <div className="ac-past__actions">
                {p.live && <Badge variant="info">{t("ac.past.live")}</Badge>}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canResume || p.live || busyId !== null}
                  loading={busyId === p.sessionId}
                  loadingText={t("ac.past.resuming")}
                  onClick={() => onResume(p.sessionId)}
                >
                  {t("ac.past.resume")}
                </Button>
              </div>
            </div>
          </Card>
        ))
      )}
    </Stack>
  );
}
