import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { TextField } from "@sa/components/TextField";
import type { ReservationInput, RoleView } from "../../types";

interface Props { roles: RoleView[]; onSave: (input: ReservationInput) => Promise<void>; }

export function ReservationEditor({ roles, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [branch, setBranch] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [promptText, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ name, roleId, cwd, ...(branch ? { branch } : {}), date, time, promptText });
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return <form onSubmit={(e) => void submit(e)}><Stack gap="3">
    <TextField label={t("ac.reservations.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required fullWidth />
    <Select label={t("ac.reservations.role")} value={roleId} onChange={(e) => setRoleId(e.target.value)} options={roles.map((r) => ({ value: r.id, label: t(r.labelKey) }))} fullWidth />
    <TextField label={t("ac.reservations.cwd")} value={cwd} onChange={(e) => setCwd(e.target.value)} required fullWidth />
    <TextField label={t("ac.reservations.branch")} value={branch} onChange={(e) => setBranch(e.target.value)} fullWidth />
    <TextField label={t("ac.reservations.date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required fullWidth />
    <TextField label={t("ac.reservations.time")} value={time} onChange={(e) => setTime(e.target.value)} helperText={t("ac.reservations.timeHint")} required fullWidth />
    <Textarea label={t("ac.reservations.prompt")} value={promptText} onChange={(e) => setPrompt(e.target.value)} maxLength={8192} rows={5} required fullWidth />
    <Callout variant="info" title={t("ac.reservations.newSessionTitle")}>{t("ac.reservations.newSessionNotice")}</Callout>
    {error && <Callout variant="warning" title={t("ac.reservations.error")}>{error}</Callout>}
    <Button type="submit" loading={busy} loadingText={t("ac.reservations.saving")}>{t("ac.reservations.save")}</Button>
  </Stack></form>;
}
