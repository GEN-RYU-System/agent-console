import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { TextField } from "@sa/components/TextField";
import type { RoleView, Routine, RoutineInput } from "../../types";

interface Props { routine?: Routine; roles: RoleView[]; onSave: (input: RoutineInput) => Promise<void>; }
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export function RoutineEditor({ routine, roles, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(routine?.name ?? ""); const [roleId, setRoleId] = useState(routine?.roleId ?? roles[0]?.id ?? ""); const [cwd, setCwd] = useState(routine?.cwd ?? ""); const [branch, setBranch] = useState(routine?.branch ?? ""); const [timeHHmm, setTime] = useState(routine?.timeHHmm ?? "09:00"); const [promptText, setPrompt] = useState(routine?.promptText ?? ""); const [weekdays, setWeekdays] = useState<number[]>(routine?.weekdays ?? [1, 2, 3, 4, 5]); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => { e.preventDefault(); setBusy(true); setError(null); try { await onSave({ name, enabled: routine?.enabled ?? true, roleId, cwd, ...(branch ? { branch } : {}), weekdays, timeHHmm, promptText }); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } };
  return <form onSubmit={(e) => void submit(e)}><Stack gap="3">
    <TextField label={t("ac.routines.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required fullWidth />
    <Select label={t("ac.routines.role")} value={roleId} onChange={(e) => setRoleId(e.target.value)} options={roles.map((r) => ({ value: r.id, label: t(r.labelKey) }))} disabled={routine !== undefined} fullWidth />
    <TextField label={t("ac.routines.cwd")} value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={routine !== undefined} required fullWidth />
    <TextField label={t("ac.routines.branch")} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={routine !== undefined} fullWidth />
    <TextField label={t("ac.routines.time")} value={timeHHmm} onChange={(e) => setTime(e.target.value)} helperText={t("ac.routines.timeHint")} required fullWidth />
    <div className="ac-routines__days">{DAYS.map((day, index) => <Button key={day} type="button" size="sm" variant={weekdays.includes(index) ? "primary" : "outline"} aria-pressed={weekdays.includes(index)} onClick={() => setWeekdays((v) => v.includes(index) ? v.filter((x) => x !== index) : [...v, index])}>{t(`ac.routines.days.${day}`)}</Button>)}</div>
    <Textarea label={t("ac.routines.prompt")} value={promptText} onChange={(e) => setPrompt(e.target.value)} maxLength={8192} rows={5} required fullWidth />
    {error && <Callout variant="warning" title={t("ac.routines.error")}>{error}</Callout>}
    <Button type="submit" loading={busy} loadingText={t("ac.routines.saving")}>{t("ac.routines.save")}</Button>
  </Stack></form>;
}
