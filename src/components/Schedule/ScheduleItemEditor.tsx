import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { Select } from "@sa/components/Select";
import { Stack } from "@sa/components/Stack";
import { Textarea } from "@sa/components/Textarea";
import { TextField } from "@sa/components/TextField";
import type { ScheduleItemInput, ScheduleKind, ScheduleSide } from "../../types";

interface Props { defaultSide: ScheduleSide; defaultDate: string; onSave: (input: ScheduleItemInput) => Promise<void>; }

const KINDS: ScheduleKind[] = ["todo", "waiting", "deadline"];

export function ScheduleItemEditor({ defaultSide, defaultDate, onSave }: Props) {
  const { t } = useTranslation();
  const [side, setSide] = useState<ScheduleSide>(defaultSide);
  const [kind, setKind] = useState<ScheduleKind>("todo");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({
        side, kind, title,
        ...(date !== "" ? { date } : {}), ...(start !== "" ? { start } : {}), ...(end !== "" ? { end } : {}),
        ...(note !== "" ? { note } : {}), ...(kind === "waiting" && waitingOn !== "" ? { waitingOn } : {}),
      });
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return <form onSubmit={(e) => void submit(e)}><Stack gap="3">
    <Select label={t("ac.scheduleBoard.field.side")} value={side} onChange={(e) => setSide(e.target.value as ScheduleSide)} options={[{ value: "dev", label: t("ac.scheduleBoard.sideDev") }, { value: "secretary", label: t("ac.scheduleBoard.sideSecretary") }]} fullWidth />
    <Select label={t("ac.scheduleBoard.field.kind")} value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)} options={KINDS.map((k) => ({ value: k, label: t(`ac.scheduleBoard.kind.${k}`) }))} fullWidth />
    <TextField label={t("ac.scheduleBoard.field.title")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required fullWidth />
    <TextField label={t("ac.scheduleBoard.field.date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} fullWidth />
    <TextField label={t("ac.scheduleBoard.field.start")} value={start} onChange={(e) => setStart(e.target.value)} helperText={t("ac.scheduleBoard.field.timeHint")} fullWidth />
    <TextField label={t("ac.scheduleBoard.field.end")} value={end} onChange={(e) => setEnd(e.target.value)} helperText={t("ac.scheduleBoard.field.timeHint")} fullWidth />
    {kind === "waiting" && <TextField label={t("ac.scheduleBoard.field.waitingOn")} value={waitingOn} onChange={(e) => setWaitingOn(e.target.value)} maxLength={100} fullWidth />}
    <Textarea label={t("ac.scheduleBoard.field.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} fullWidth />
    {error && <Callout variant="warning" title={t("ac.scheduleBoard.saveFailed")}>{error}</Callout>}
    <Button type="submit" loading={busy}>{t("ac.scheduleBoard.save")}</Button>
  </Stack></form>;
}
