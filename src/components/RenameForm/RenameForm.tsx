import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Stack } from "@sa/components/Stack";
import { TextField } from "@sa/components/TextField";
import type { SessionView } from "../../types";

interface Props {
  session: SessionView;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}

/** 名前の変更。Claude 起動中は Claude の /rename（待ち・待機のときだけ）、それ以外はアプリ側の名前。 */
export function RenameForm({ session, busy, error, onSubmit }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(session.name);
  const blocked = !session.canInput;

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit(name);
  };

  return (
    <form onSubmit={handleSubmit} data-testid="rename-form">
      <Stack gap="4">
        <TextField
          label={t("ac.rename.name")}
          helperText={session.hasClaude ? t("ac.rename.hintClaude") : t("ac.rename.hintApp")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          disabled={blocked}
          fullWidth
        />
        {blocked && <Callout variant="info" title={t("ac.rename.busyTitle")}>{t("ac.rename.busyBody")}</Callout>}
        {error !== null && (
          <Callout variant="warning" title={t("ac.rename.error")}>
            {error}
          </Callout>
        )}
        <Button type="submit" disabled={blocked} loading={busy} loadingText={t("ac.rename.sending")}>
          {t("ac.rename.submit")}
        </Button>
      </Stack>
    </form>
  );
}
