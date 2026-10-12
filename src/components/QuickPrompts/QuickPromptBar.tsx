import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Modal } from "@sa/components/Modal";
import { Stack } from "@sa/components/Stack";
import { updateQuickPrompt } from "../../api";
import type { QuickPrompt } from "../../types";
import "./QuickPrompts.css";

interface Props {
  prompts: QuickPrompt[];
  /** 選択中のセッションが送れる状態か（無い・停止中は false） */
  canSend: boolean;
  onSend: (promptId: string) => void;
  onEdit: () => void;
  /** 「常に表示」を切り替えたあとに一覧を読み直す */
  onChanged: () => void;
}

/** 端末の上に並ぶ「よく使う指示」のバー（1 行）。常に表示にした指示だけを並べ、全件は左のボタンで開く一覧から使う。人が押したときだけ、選択中の端末へ送る。 */
export function QuickPromptBar({ prompts, canSend, onSend, onEdit, onChanged }: Props) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinned = prompts.filter((p) => p.pinned);

  const handleTogglePinned = (p: QuickPrompt): void => {
    setError(null);
    updateQuickPrompt(p.id, { pinned: !p.pinned }).then(onChanged, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleUse = (id: string): void => {
    setListOpen(false);
    onSend(id);
  };

  return (
    <div className="ac-quick" data-testid="quick-prompt-bar" role="toolbar" aria-label={t("ac.quick.title")}>
      <Button variant="ghost" size="sm" layoutClassName="ac-quick__list-button" onClick={() => setListOpen(true)}>
        {t("ac.quick.title")}
      </Button>
      <div className="ac-quick__buttons">
        {prompts.length === 0 && <span className="ac-quick__empty">{t("ac.quick.empty")}</span>}
        {prompts.length > 0 && pinned.length === 0 && <span className="ac-quick__empty">{t("ac.quick.noPinned")}</span>}
        {pinned.map((p) => (
          <Button key={p.id} variant="outline" size="sm" disabled={!canSend} onClick={() => onSend(p.id)} title={p.text}>
            {p.label}
          </Button>
        ))}
      </div>
      <Button variant="ghost" size="sm" layoutClassName="ac-quick__edit-button" onClick={onEdit}>
        {t("ac.quick.edit")}
      </Button>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title={t("ac.quick.listTitle")} size="md">
        <Stack gap="2">
          {error !== null && (
            <Callout variant="warning" title={t("ac.quick.error")}>
              {error}
            </Callout>
          )}
          {prompts.length === 0 && <span className="ac-quick__empty">{t("ac.quick.empty")}</span>}
          {prompts.map((p) => (
            <div key={p.id} className="ac-quick-list__item" data-testid="quick-prompt-list-item">
              <div className="ac-quick-editor__text">
                <span className="ac-quick-editor__label" data-testid="quick-prompt-list-label">{p.label}</span>
                <span className="ac-quick-editor__preview">{p.text}</span>
              </div>
              <div className="ac-quick-editor__actions">
                <Button variant="tab" size="sm" active={p.pinned} onClick={() => handleTogglePinned(p)} title={t("ac.quick.pinnedTitle")}>
                  {t("ac.quick.pinned")}
                </Button>
                <Button variant="primary" size="sm" disabled={!canSend} onClick={() => handleUse(p.id)}>
                  {t("ac.quick.use")}
                </Button>
              </div>
            </div>
          ))}
        </Stack>
      </Modal>
    </div>
  );
}
