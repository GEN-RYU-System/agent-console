import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { EmptyState } from "@sa/components/EmptyState";
import { Stack } from "@sa/components/Stack";
import type { RoleView, SessionView } from "../../types";
import { STATE_LABEL_KEY, StatusDot } from "../StatusDot/StatusDot";
import "./SessionList.css";

const CI_BADGES = {
  fail: { variant: "danger", labelKey: "ac.ci.fail" },
  pending: { variant: "info", labelKey: "ac.ci.pending" },
  pass: { variant: "success", labelKey: "ac.ci.pass" },
} as const;

interface Props {
  sessions: SessionView[];
  roles: RoleView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string) => void;
  /** 動いているセッションを閉じる（確認画面は呼び出し側） */
  onClose: (id: string) => void;
  /** 並び順を変える。toIndex は動かしたあとの位置（0 始まり） */
  onMove: (id: string, toIndex: number) => void;
}

export function SessionList({ sessions, roles, selectedId, onSelect, onRemove, onRename, onClose, onMove }: Props) {
  const { t } = useTranslation();
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (sessions.length === 0) {
    return <EmptyState size="compact" title={t("ac.noSessions")} description={t("ac.noSessionsHint")} />;
  }
  const roleLabel = (id: string): string => {
    const role = roles.find((r) => r.id === id);
    return role ? t(role.labelKey) : id;
  };
  const endDrag = (): void => {
    dragId.current = null;
    setDraggingId(null);
    setOverId(null);
  };
  const handleDragStart = (e: DragEvent, id: string): void => {
    dragId.current = id;
    setDraggingId(id);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox は setData が無いとドラッグが始まらない
      e.dataTransfer.setData("text/plain", id);
    }
  };
  const handleDragOver = (e: DragEvent, id: string): void => {
    if (dragId.current === null) return;
    e.preventDefault();
    if (overId !== id) setOverId(id);
  };
  const handleDrop = (e: DragEvent, id: string): void => {
    const dragged = dragId.current;
    endDrag();
    if (dragged === null || dragged === id) return;
    e.preventDefault();
    const toIndex = sessions.findIndex((x) => x.id === id);
    if (toIndex >= 0) onMove(dragged, toIndex);
  };
  // 行の div にはフォーカスが乗らないので、選択のボタンで Alt+↑ / Alt+↓ を受ける
  const handleKeyDown = (e: KeyboardEvent, index: number, id: string): void => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const toIndex = e.key === "ArrowUp" ? index - 1 : index + 1;
    if (toIndex < 0 || toIndex >= sessions.length) return;
    e.preventDefault();
    onMove(id, toIndex);
  };
  const rowClass = (s: SessionView): string =>
    ["ac-session", s.id === selectedId ? "ac-session--selected" : "", s.id === draggingId ? "ac-session--dragging" : "", s.id === overId && s.id !== draggingId ? "ac-session--over" : ""]
      .filter((c) => c !== "")
      .join(" ");
  return (
    <Stack gap="1">
      {sessions.map((s, index) => (
        <div
          key={s.id}
          draggable
          onDragStart={(e) => handleDragStart(e, s.id)}
          onDragOver={(e) => handleDragOver(e, s.id)}
          onDrop={(e) => handleDrop(e, s.id)}
          onDragEnd={endDrag}
          data-testid="session-row"
          data-session-id={s.id}
          data-state={s.state}
          data-unread={s.unread}
          className={rowClass(s)}
        >
          <Button
            variant="ghost"
            size="sm"
            layoutClassName="ac-session__select"
            aria-current={s.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => handleKeyDown(e, index, s.id)}
            onDoubleClick={() => {
              if (s.state !== "stopped") onRename(s.id);
            }}
          >
            <span className="ac-session__line" data-testid="session-line-1">
              <StatusDot state={s.state} showLabel={false} />
              <span className="ac-session__name" data-testid="session-name">{s.name}</span>
              {s.unread > 0 && (
                <span data-testid="unread-badge">
                  <Badge variant="info" appearance="solid" size="sm">
                    {t("ac.unread", { count: s.unread })}
                  </Badge>
                </span>
              )}
            </span>
            <span className="ac-session__sub" data-testid="session-line-2">
              <span className="ac-session__role">{roleLabel(s.roleId)}</span>
              <span data-testid="state-badge" data-state={s.state}>
                <Badge variant="neutral" size="sm">
                  {t(STATE_LABEL_KEY[s.state])}
                </Badge>
              </span>
              {s.ci !== undefined && (
                <span data-testid="ci-badge" data-ci={s.ci}>
                  <Badge variant={CI_BADGES[s.ci].variant} size="sm">
                    {t(CI_BADGES[s.ci].labelKey)}
                  </Badge>
                </span>
              )}
              {s.pendingName !== undefined && (
                <span className="ac-session__pending" data-testid="pending-name">
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
          {s.state !== "stopped" && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t("ac.close.open")}
              title={t("ac.close.open")}
              data-testid="close-session"
              onClick={() => onClose(s.id)}
            >
              <X size={14} aria-hidden="true" />
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
