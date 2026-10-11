import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { Stack } from "@sa/components/Stack";
import type { RoleView, SessionView } from "../../types";
import { StatusDot } from "../StatusDot/StatusDot";
import "./SessionList.css";

interface Props {
  sessions: SessionView[];
  roles: RoleView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string) => void;
}

export function SessionList({ sessions, roles, selectedId, onSelect, onRemove, onRename }: Props) {
  const { t } = useTranslation();
  if (sessions.length === 0) {
    return <EmptyState size="compact" title={t("ac.noSessions")} description={t("ac.noSessionsHint")} />;
  }
  const roleLabel = (id: string): string => {
    const role = roles.find((r) => r.id === id);
    return role ? t(role.labelKey) : id;
  };
  return (
    <Stack gap="2">
      {sessions.map((s) => (
        <Card
          key={s.id}
          density="compact"
          data-testid="session-row"
          data-session-id={s.id}
          data-state={s.state}
          data-unread={s.unread}
          className={s.id === selectedId ? "ac-session ac-session--selected" : "ac-session"}
        >
          <Button
            variant="ghost"
            fullWidth
            layoutClassName="ac-session__select"
            aria-current={s.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(s.id)}
          >
            <span className="ac-session__name">{s.name}</span>
            <span className="ac-session__role">{roleLabel(s.roleId)}</span>
            <span className="ac-session__status">
              <StatusDot state={s.state} />
              {s.unread > 0 && (
                <span data-testid="unread-badge">
                  <Badge variant="info" appearance="solid" size="sm">
                    {t("ac.unread", { count: s.unread })}
                  </Badge>
                </span>
              )}
            </span>
          </Button>
          <div className="ac-session__actions">
            {s.state !== "stopped" && (
              <Button variant="ghost" size="sm" onClick={() => onRename(s.id)}>
                {t("ac.rename.open")}
              </Button>
            )}
            {s.state === "stopped" && (
              <Button variant="outline" size="sm" onClick={() => onRemove(s.id)}>
                {t("ac.removeSession")}
              </Button>
            )}
          </div>
        </Card>
      ))}
    </Stack>
  );
}
