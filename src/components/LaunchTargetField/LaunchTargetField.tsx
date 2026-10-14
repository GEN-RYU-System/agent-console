import { useTranslation } from "react-i18next";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import type { ResumeTarget, RoleView } from "../../types";
import { nameOf } from "../ResumePicker/ResumePicker";

interface Props {
  role: RoleView | undefined;
  /** null: 読み込み中 */
  targets: ResumeTarget[] | null;
  loadError: boolean;
  /** 選んだ作業用コピーの path */
  value: string;
  onChange: (path: string) => void;
}

/** 予約・定期実行の「作業場所」。本店で動く役割は一文だけ、作業用コピーで動く役割は一覧から選ぶ。表示だけを受け持つ（一覧の取得・保存可否は親）。 */
export function LaunchTargetField({ role, targets, loadError, value, onChange }: Props) {
  const { t } = useTranslation();
  if (!role?.needsWorktree) {
    return <Callout variant="info" title={t("ac.launchTarget.mainTitle")}>{t("ac.launchTarget.mainOnly")}</Callout>;
  }
  if (loadError) return <Callout variant="warning" title={t("ac.launchTarget.loadFailedTitle")}>{t("ac.launchTarget.loadFailed")}</Callout>;
  if (targets === null) return <Select label={t("ac.launchTarget.worktree")} value="" onChange={() => {}} options={[]} placeholder={t("ac.launchTarget.loading")} disabled fullWidth />;
  const worktrees = targets.filter((x) => x.kind === "worktree");
  if (worktrees.length === 0) return <Callout variant="warning" title={t("ac.launchTarget.noneTitle")}>{t("ac.launchTarget.none")}</Callout>;
  return (
    <Select
      label={t("ac.launchTarget.worktree")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={worktrees.map((x) => ({ value: x.path, label: x.branch === null ? `${nameOf(x)}${t("ac.launchTarget.noBranch")}` : nameOf(x), disabled: x.branch === null }))}
      placeholder={t("ac.launchTarget.choose")}
      helperText={t("ac.launchTarget.worktreeHelp")}
      required
      fullWidth
    />
  );
}
