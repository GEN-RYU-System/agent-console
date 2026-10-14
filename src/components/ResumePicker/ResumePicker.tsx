import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { EmptyState } from "@sa/components/EmptyState";
import { Stack } from "@sa/components/Stack";
import { TextField } from "@sa/components/TextField";
import type { ResumeTarget } from "../../types";
import "./ResumePicker.css";

interface Props {
  /** null: 読み込み中 */
  items: ResumeTarget[] | null;
  /** 再開を依頼中の作業場所（path） */
  busyPath: string | null;
  error: string | null;
  onResume: (target: ResumeTarget) => void;
}

/** 行の名前: ブランチ名。detached などで無いときは作業場所の末尾。 */
export const nameOf = (target: ResumeTarget): string => target.branch ?? target.path.split("/").filter(Boolean).pop() ?? target.path;

/** 会話の一覧と選択は Claude 公式の選択リスト（端末内）に任せる。ここは再開する作業場所を選ぶだけ。 */
export function ResumePicker({ items, busyPath, error, onResume }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((x) => x.kind === "main" || needle === "" || nameOf(x).toLowerCase().includes(needle));
  }, [items, query]);
  if (items === null) return <span className="ac-resume__muted">{t("ac.resume.loading")}</span>;
  const hasWorktree = items.some((x) => x.kind === "worktree");
  const noMatch = hasWorktree && rows.every((x) => x.kind === "main");
  return (
    <Stack gap="3">
      <Callout variant="info" title={t("ac.resume.guideTitle")}>
        <span data-testid="resume-guide">{t("ac.resume.guide")}</span>
      </Callout>
      {error !== null && (
        <Callout variant="warning" title={t("ac.resume.error")}>
          {error}
        </Callout>
      )}
      {hasWorktree && <TextField size="sm" label={t("ac.resume.filter")} value={query} onChange={(e) => setQuery(e.target.value)} fullWidth />}
      {items.length === 0 ? (
        <EmptyState size="compact" title={t("ac.resume.empty")} />
      ) : (
        rows.map((x) => (
          <Card key={`${x.kind}:${x.path}`} density="compact" data-testid="resume-target" data-kind={x.kind} data-path={x.path}>
            <div className="ac-resume__row">
              <div className="ac-resume__text">
                <span className="ac-resume__name">{x.kind === "main" ? t("ac.resume.mainRow") : t("ac.resume.worktreeRow", { name: nameOf(x) })}</span>
                <span className="ac-resume__muted">{x.path}</span>
              </div>
              <Button variant="outline" size="sm" disabled={busyPath !== null} loading={busyPath === x.path} loadingText={t("ac.resume.resuming")} onClick={() => onResume(x)}>
                {t("ac.resume.resume")}
              </Button>
            </div>
          </Card>
        ))
      )}
      {noMatch && <EmptyState size="compact" title={t("ac.resume.noMatch")} />}
    </Stack>
  );
}
