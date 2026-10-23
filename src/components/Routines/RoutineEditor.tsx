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
import { previewRoutineSchedule } from "../../api";
import { ScheduleOverlapNotice } from "../ScheduleOverlap/ScheduleOverlapNotice";
import { useSchedulePreview } from "../ScheduleOverlap/useSchedulePreview";
import type { RoleView, Routine, RoutineInput } from "../../types";

interface Props { routine?: Routine; roles: RoleView[]; onSave: (input: RoutineInput) => Promise<void>; }
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export function RoutineEditor({ routine, roles, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(routine?.name ?? ""); const [roleId, setRoleId] = useState(routine?.roleId ?? roles[0]?.id ?? ""); const [picked, setPicked] = useState(""); const [timeHHmm, setTime] = useState(routine?.timeHHmm ?? "09:00"); const [promptText, setPrompt] = useState(routine?.promptText ?? ""); const [weekdays, setWeekdays] = useState<number[]>(routine?.weekdays ?? [1, 2, 3, 4, 5]); const [closeWhenIdle, setCloseWhenIdle] = useState(routine?.closeWhenIdle === true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const role = roles.find((r) => r.id === roleId); const { targets, loadError } = useLaunchTargets(routine === undefined);
  const { preview, failed: previewFailed } = useSchedulePreview((routine?.enabled ?? true) && weekdays.length > 0 && /^\d{2}:\d{2}$/.test(timeHHmm), `${weekdays.join(",")} ${timeHHmm}`, () => previewRoutineSchedule(weekdays, timeHHmm, routine?.id));
  const submit = async (e: FormEvent): Promise<void> => { e.preventDefault(); setBusy(true); setError(null); try { await onSave({ name, enabled: routine?.enabled ?? true, roleId, ...(routine ? { cwd: routine.cwd, ...(routine.branch ? { branch: routine.branch } : {}) } : launchFields(role, targets, picked)), weekdays, timeHHmm, promptText, closeWhenIdle }); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } };
  return <form onSubmit={(e) => void submit(e)}><Stack gap="3">
    <TextField label={t("ac.routines.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required fullWidth />
    <Select label={t("ac.routines.role")} value={roleId} onChange={(e) => { setRoleId(e.target.value); setPicked(""); }} options={roles.map((r) => ({ value: r.id, label: t(r.labelKey) }))} disabled={routine !== undefined} fullWidth />
    {routine ? <>
      <TextField label={t("ac.routines.cwd")} value={routine.cwd} disabled fullWidth />
      <TextField label={t("ac.routines.branch")} value={routine.branch ?? ""} disabled fullWidth />
    </> : <LaunchTargetField role={role} targets={targets} loadError={loadError} value={picked} onChange={setPicked} />}
    <TextField label={t("ac.routines.time")} value={timeHHmm} onChange={(e) => setTime(e.target.value)} helperText={t("ac.routines.timeHint")} required fullWidth />
    <div className="ac-routines__days">{DAYS.map((day, index) => <Button key={day} type="button" size="sm" variant={weekdays.includes(index) ? "primary" : "outline"} aria-pressed={weekdays.includes(index)} onClick={() => setWeekdays((v) => v.includes(index) ? v.filter((x) => x !== index) : [...v, index])}>{t(`ac.routines.days.${day}`)}</Button>)}</div>
    <Textarea label={t("ac.routines.prompt")} value={promptText} onChange={(e) => setPrompt(e.target.value)} maxLength={8192} rows={5} required fullWidth />
    <Select label={t("ac.routines.closeWhenIdle")} value={closeWhenIdle ? "yes" : "no"} onChange={(e) => setCloseWhenIdle(e.target.value === "yes")} options={[{ value: "no", label: t("ac.routines.closeNo") }, { value: "yes", label: t("ac.routines.closeYes") }]} helperText={t("ac.routines.closeWhenIdleHint")} fullWidth />
    <Callout variant="info" title={t("ac.routines.newSessionTitle")}>{t("ac.routines.newSessionNotice")}</Callout>
    <ScheduleOverlapNotice preview={preview} failed={previewFailed} />
    {error && <Callout variant="warning" title={t("ac.routines.error")}>{error}</Callout>}
    <Button type="submit" disabled={routine === undefined && launchBlocked(role, targets, loadError)} loading={busy} loadingText={t("ac.routines.saving")}>{t("ac.routines.save")}</Button>
  </Stack></form>;
}
