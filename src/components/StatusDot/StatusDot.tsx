import { useTranslation } from "react-i18next";
import type { SessionState } from "../../types";
import "./StatusDot.css";

const LABEL_KEY: Record<SessionState, string> = {
  working: "ac.state.working",
  waiting: "ac.state.waiting",
  idle: "ac.state.idle",
  "no-claude": "ac.state.noClaude",
  stopped: "ac.state.stopped",
  unknown: "ac.state.unknown",
};

export function StatusDot({ state }: { state: SessionState }) {
  const { t } = useTranslation();
  return (
    <span className="ac-status" data-testid="status" data-state={state}>
      <span className={`ac-status__dot ac-status__dot--${state}`} aria-hidden="true" />
      <span className="ac-status__label">{t(LABEL_KEY[state])}</span>
    </span>
  );
}
