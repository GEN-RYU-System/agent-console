import { useTranslation } from "react-i18next";
import { Callout } from "@sa/components/Callout";
import { Stack } from "@sa/components/Stack";
import { formatJst } from "../Reservations/formatJst";
import type { SchedulePreview } from "../../types";

interface Props { preview: SchedulePreview | null; failed: boolean; }

/** 日時の形（YYYY-MM-DDTHH:mm+09:00）なら整形し、HH:mm はそのまま。無ければ「なし」 */
const FULL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const shown = (value: string | null, none: string): string => (value === null ? none : FULL.test(value) ? formatJst(value) : value);

/** 予約・定期実行の作成の画面で、ほかとの開始の重なりを知らせる確認の欄（保存は止めない） */
export function ScheduleOverlapNotice({ preview, failed }: Props) {
  const { t } = useTranslation();
  const wrap = (children: React.ReactNode) => <div data-testid="schedule-overlap">{children}</div>;
  if (failed) return wrap(<Callout variant="warning" title={t("ac.schedule.checkFailedTitle")}>{t("ac.schedule.checkFailed")}</Callout>);
  if (preview === null) return null;
  if (!preview.ready) return wrap(<Callout variant="warning" title={t("ac.schedule.notReadyTitle")}>{t("ac.schedule.notReady")}</Callout>);
  const o = preview.overlap;
  if (o === null) return null;
  const none = t("ac.schedule.none");
  return wrap(<Callout variant="warning" title={t("ac.schedule.overlapTitle")}>
    <Stack gap="1">
      <span>{t("ac.schedule.overlapBody", { name: o.name, kind: t(`ac.schedule.kind.${o.kind}`), at: formatJst(o.at) })}</span>
      <span>{t("ac.schedule.freeTimes", { before: shown(o.before, none), after: shown(o.after, none) })}</span>
      <span>{t("ac.schedule.saveAllowed")}</span>
    </Stack>
  </Callout>);
}
