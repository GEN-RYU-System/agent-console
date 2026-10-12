import { useTranslation } from "react-i18next";
import type { SessionState } from "../../types";
import "./StatusDot.css";

export const STATE_LABEL_KEY: Record<SessionState, string> = {
  working: "ac.state.working",
  waiting: "ac.state.waiting",
  idle: "ac.state.idle",
  "no-claude": "ac.state.noClaude",
  stopped: "ac.state.stopped",
  unknown: "ac.state.unknown",
};

/** showLabel={false} は丸だけを出す（状態の文字は呼び出し側が別の場所に出す）。 */
export function StatusDot({ state, showLabel = true }: { state: SessionState; showLabel?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="ac-status" data-testid="status" data-state={state}>
      <span className={`ac-status__dot ac-status__dot--${state}`} aria-hidden="true" />
      {showLabel && <span className="ac-status__label">{t(STATE_LABEL_KEY[state])}</span>}
    </span>
  );
}
