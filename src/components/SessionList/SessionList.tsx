import { Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
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
    <Stack gap="1">
      {sessions.map((s) => (
        <div
          key={s.id}
          data-testid="session-row"
          data-session-id={s.id}
          data-state={s.state}
          data-unread={s.unread}
          className={s.id === selectedId ? "ac-session ac-session--selected" : "ac-session"}
        >
          <Button
            variant="ghost"
            size="sm"
            layoutClassName="ac-session__select"
            aria-current={s.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => {
              if (s.state !== "stopped") onRename(s.id);
            }}
          >
            <span className="ac-session__line" data-testid="session-line-1">
              <StatusDot state={s.state} />
              <span className="ac-session__name" data-testid="session-name">{s.name}</span>
              {s.unread > 0 && (
                <span data-testid="unread-badge">
                  <Badge variant="info" appearance="solid" size="sm">
                    {t("ac.unread", { count: s.unread })}
                  </Badge>
                </span>
              )}
            </span>
            <span className="ac-session__role" data-testid="session-line-2">
              {roleLabel(s.roleId)}
              {s.pendingName !== undefined && (
                <span className="ac-session__pending" data-testid="pending-name">
                  {" "}
                  {t("ac.rename.pendingLine", { name: s.pendingName })}
                </span>
              )}
            </span>
          </Button>
          {s.state !== "stopped" && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t("ac.rename.open")}
              title={t("ac.rename.open")}
              onClick={() => onRename(s.id)}
            >
              <Pencil size={14} aria-hidden="true" />
            </Button>
          )}
          {s.state === "stopped" && (
            <Button
              variant="outline"
              size="sm"
              iconOnly
              aria-label={t("ac.removeSession")}
              title={t("ac.removeSession")}
              onClick={() => onRemove(s.id)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
    </Stack>
  );
}
