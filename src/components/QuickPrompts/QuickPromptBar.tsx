import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import type { QuickPrompt } from "../../types";
import "./QuickPrompts.css";

interface Props {
  prompts: QuickPrompt[];
  /** 選択中のセッションが送れる状態か（無い・停止中は false） */
  canSend: boolean;
  onSend: (promptId: string) => void;
  onEdit: () => void;
}

/** 端末の上に並ぶ「よく使う指示」のボタン。人が押したときだけ、選択中の端末へ送る。 */
export function QuickPromptBar({ prompts, canSend, onSend, onEdit }: Props) {
  const { t } = useTranslation();
  return (
    <div className="ac-quick" data-testid="quick-prompt-bar" role="toolbar" aria-label={t("ac.quick.title")}>
      <span className="ac-quick__title">{t("ac.quick.title")}</span>
      <div className="ac-quick__buttons">
        {prompts.length === 0 && <span className="ac-quick__empty">{t("ac.quick.empty")}</span>}
        {prompts.map((p) => (
          <Button key={p.id} variant="outline" size="sm" disabled={!canSend} onClick={() => onSend(p.id)} title={p.text}>
            {p.label}
          </Button>
        ))}
      </div>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        {t("ac.quick.edit")}
      </Button>
    </div>
  );
}
