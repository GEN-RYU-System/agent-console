import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Card } from "@sa/components/Card";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { TextField } from "@sa/components/TextField";
import { createQuickPrompt, deleteQuickPrompt, moveQuickPrompt, updateQuickPrompt } from "../../api";
import type { QuickPrompt } from "../../types";
import "./QuickPrompts.css";

const MAX_LABEL_LENGTH = 40;
const MAX_PROMPT_CHARS = 8192;

interface Props {
  prompts: QuickPrompt[];
  /** 追加・更新・削除のあとに一覧を読み直す */
  onChanged: () => void;
}

/** よく使う指示の登録・編集・削除。保存先はサーバーの 1 ファイルだけ（画面は保存しない）。 */
export function QuickPromptEditor({ prompts, onChanged }: Props) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setEditingId(null);
    setLabel("");
    setText("");
  };

  const run = async (task: () => Promise<unknown>, keepForm = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
      onChanged();
      if (!keepForm) reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void run(() => (editingId === null ? createQuickPrompt({ label, text }) : updateQuickPrompt(editingId, { label, text })));
  };

  const startEdit = (p: QuickPrompt): void => {
    setEditingId(p.id);
    setLabel(p.label);
    setText(p.text);
    setError(null);
  };

  return (
    <Stack gap="4">
      <Stack gap="2">
        {prompts.length === 0 && <span className="ac-quick__empty">{t("ac.quick.empty")}</span>}
        {prompts.map((p, index) => (
          <Card key={p.id} density="compact" data-testid="quick-prompt-item">
            <div className="ac-quick-editor__item">
              <div className="ac-quick-editor__text">
                <span className="ac-quick-editor__label">{p.label}</span>
                <span className="ac-quick-editor__preview">{p.text}</span>
              </div>
              <div className="ac-quick-editor__actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || index === 0}
                  aria-label={t("ac.quick.moveUp")}
                  title={t("ac.quick.moveUpTitle")}
                  onClick={() => void run(() => moveQuickPrompt(p.id, "up"), true)}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || index === prompts.length - 1}
                  aria-label={t("ac.quick.moveDown")}
                  title={t("ac.quick.moveDownTitle")}
                  onClick={() => void run(() => moveQuickPrompt(p.id, "down"), true)}
                >
                  ↓
                </Button>
                <Button variant="outline" size="sm" onClick={() => startEdit(p)}>
                  {t("ac.quick.editItem")}
                </Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void run(() => deleteQuickPrompt(p.id))}>
                  {t("ac.quick.delete")}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </Stack>
      <form onSubmit={handleSubmit} data-testid="quick-prompt-form">
        <Stack gap="3">
          <TextField label={t("ac.quick.label")} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={MAX_LABEL_LENGTH} required fullWidth />
          <Textarea
            label={t("ac.quick.text")}
            helperText={t("ac.quick.textHint")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_PROMPT_CHARS}
            rows={4}
            required
            fullWidth
          />
          {error !== null && (
            <Callout variant="warning" title={t("ac.quick.error")}>
              {error}
            </Callout>
          )}
          <div className="ac-quick-editor__actions">
            <Button type="submit" loading={busy} loadingText={t("ac.quick.saving")}>
              {editingId === null ? t("ac.quick.add") : t("ac.quick.save")}
            </Button>
            {editingId !== null && (
              <Button variant="ghost" onClick={reset}>
                {t("ac.quick.cancel")}
              </Button>
            )}
          </div>
        </Stack>
      </form>
    </Stack>
  );
}
