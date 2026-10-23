import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { TextField } from "@sa/components/TextField";
import { LaunchTargetField } from "../LaunchTargetField/LaunchTargetField";
import { launchBlocked, launchFields, useLaunchTargets } from "../LaunchTargetField/launchTarget";
import { previewReservationSchedule } from "../../api";
import { ScheduleOverlapNotice } from "../ScheduleOverlap/ScheduleOverlapNotice";
import { useSchedulePreview } from "../ScheduleOverlap/useSchedulePreview";
import type { ReservationInput, RoleView } from "../../types";

interface Props { roles: RoleView[]; onSave: (input: ReservationInput) => Promise<void>; }

export function ReservationEditor({ roles: allRoles, onSave }: Props) {
  const { t } = useTranslation();
  const roles = allRoles.filter((r) => r.reservable !== false);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [picked, setPicked] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [promptText, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = roles.find((r) => r.id === roleId);
  const { targets, loadError } = useLaunchTargets(true);
  const { preview, failed: previewFailed } = useSchedulePreview(date !== "" && /^\d{2}:\d{2}$/.test(time), `${date} ${time}`, () => previewReservationSchedule(date, time));
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ name, roleId, ...launchFields(role, targets, picked), date, time, promptText });
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return <form onSubmit={(e) => void submit(e)}><Stack gap="3">
    <TextField label={t("ac.reservations.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required fullWidth />
    <Select label={t("ac.reservations.role")} value={roleId} onChange={(e) => { setRoleId(e.target.value); setPicked(""); }} options={roles.map((r) => ({ value: r.id, label: t(r.labelKey) }))} fullWidth />
    <LaunchTargetField role={role} targets={targets} loadError={loadError} value={picked} onChange={setPicked} />
    <TextField label={t("ac.reservations.date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required fullWidth />
    <TextField label={t("ac.reservations.time")} value={time} onChange={(e) => setTime(e.target.value)} helperText={t("ac.reservations.timeHint")} required fullWidth />
    <Textarea label={t("ac.reservations.prompt")} value={promptText} onChange={(e) => setPrompt(e.target.value)} maxLength={8192} rows={5} required fullWidth />
    <Callout variant="info" title={t("ac.reservations.newSessionTitle")}>{t("ac.reservations.newSessionNotice")}</Callout>
    <ScheduleOverlapNotice preview={preview} failed={previewFailed} />
    {error && <Callout variant="warning" title={t("ac.reservations.error")}>{error}</Callout>}
    <Button type="submit" disabled={launchBlocked(role, targets, loadError)} loading={busy} loadingText={t("ac.reservations.saving")}>{t("ac.reservations.save")}</Button>
  </Stack></form>;
}
