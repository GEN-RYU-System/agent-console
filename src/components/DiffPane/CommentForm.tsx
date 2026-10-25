import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";

const MAX_COMMENT_CHARS = 2000;
const ROWS = 3;

interface Props {
  initialBody?: string;
  /** 保存。失敗したら例外を投げる（入力は残し、メッセージを出す） */
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

/** コメントの入力欄（SA の Textarea と Button）。保存先はサーバーだけ。 */
export function CommentForm({ initialBody = "", onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="ac-diff__form" data-testid="diff-comment-form">
      <Stack gap="2">
        <Textarea
          aria-label={t("ac.diff.commentLabel")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={MAX_COMMENT_CHARS}
          rows={ROWS}
          size="sm"
          fullWidth
          autoFocus
        />
        {error !== null && (
          <Callout variant="warning" title={t("ac.diff.commentError")}>
            {error}
          </Callout>
        )}
        <div className="ac-diff__actions">
          <Button size="sm" loading={busy} disabled={body.trim() === ""} onClick={() => void submit()}>
            {t("ac.diff.commentSave")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {t("ac.diff.commentCancel")}
          </Button>
        </div>
      </Stack>
    </div>
  );
}
