import { useTranslation } from "react-i18next";
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
}

export function SessionList({ sessions, roles, selectedId, onSelect }: Props) {
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
          variant="interactive"
          density="compact"
          role="button"
          tabIndex={0}
          aria-pressed={s.id === selectedId}
          data-testid="session-row"
          data-session-id={s.id}
          data-state={s.state}
          className={s.id === selectedId ? "ac-session ac-session--selected" : "ac-session"}
          onClick={() => onSelect(s.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(s.id);
            }
          }}
        >
          <span className="ac-session__name">{s.name}</span>
          <span className="ac-session__role">{roleLabel(s.roleId)}</span>
          <StatusDot state={s.state} />
        </Card>
      ))}
    </Stack>
  );
}
