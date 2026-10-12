import type { ActivityAgent } from "../../types";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

type NamedAgent = Pick<ActivityAgent, "subagentType" | "model" | "resolvedModel">;

/**
 * 担当の呼び名。model → resolvedModel の順に、小文字にして表のキー（sonnet・opus・fable・haiku）を部分一致で探す。
 * 見つかれば表の名前、無ければ subagent_type をそのまま出す。表は ja.json（ac.activity.models）だけが持つ。
 */
export function agentLabel(agent: NamedAgent, models: Readonly<Record<string, string>>): string {
  for (const candidate of [agent.model, agent.resolvedModel]) {
    const lowered = candidate.toLowerCase();
    if (lowered === "") continue;
    const key = Object.keys(models).find((k) => lowered.includes(k.toLowerCase()));
    if (key !== undefined) return models[key];
  }
  return agent.subagentType;
}

export type DurationUnit = "second" | "minute" | "hour" | "day";

/** 経過時間を、画面に出す単位（秒・分・時間・日）と数に直す。負の値は 0 秒 */
export function formatDuration(ms: number): { unit: DurationUnit; count: number } {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) return { unit: "second", count: seconds };
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return { unit: "hour", count: hours };
  return { unit: "day", count: Math.floor(hours / HOURS_PER_DAY) };
}
