import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import { Stack } from "@sa/components/Stack";
import { TextField } from "@sa/components/TextField";
import type { RoleView } from "../../types";

export interface NewSessionValues {
  name: string;
  roleId: string;
  branch?: string;
}

interface Props {
  roles: RoleView[];
  busy: boolean;
  error: string | null;
  onSubmit: (values: NewSessionValues) => void;
}

export function NewSessionForm({ roles, busy, error, onSubmit }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const needsWorktree = roles.find((r) => r.id === roleId)?.needsWorktree ?? false;

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit({ name, roleId, branch: needsWorktree ? branch : undefined });
  };

  return (
    <form onSubmit={handleSubmit} data-testid="new-session-form">
      <Stack gap="4">
        <TextField label={t("ac.form.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required fullWidth />
        <Select
          label={t("ac.form.role")}
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          options={roles.map((r) => ({ value: r.id, label: t(r.labelKey) }))}
          fullWidth
        />
        {needsWorktree && (
          <TextField
            label={t("ac.form.branch")}
            helperText={t("ac.form.branchHint")}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={t("ac.form.branchPlaceholder")}
            required
            fullWidth
          />
        )}
        {error !== null && (
          <Callout variant="warning" title={t("ac.form.error")}>
            {error}
          </Callout>
        )}
        <Button type="submit" loading={busy}>
          {t("ac.form.submit")}
        </Button>
      </Stack>
    </form>
  );
}
