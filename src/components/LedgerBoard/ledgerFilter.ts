import { LEDGER_COLUMNS, type LedgerCard, type LedgerGroups, type LedgerSnapshot } from "../../types";

export type LedgerPeriod = "7" | "30" | "90" | "all";
/** active=作業中・レビュー・WIP（既定）、all=すべて、それ以外は台帳の状態の値、UNREGISTERED=未登録/衝突 */
export type LedgerStateFilter = "active" | "all" | "IN_PROGRESS" | "REVIEW" | "WIP" | "DONE" | "UNREGISTERED";

export interface LedgerFilter {
  period: LedgerPeriod;
  state: LedgerStateFilter;
  query: string;
}

export const DEFAULT_LEDGER_FILTER: LedgerFilter = { period: "30", state: "active", query: "" };
export const LEDGER_PERIODS: readonly LedgerPeriod[] = ["7", "30", "90", "all"];
export const LEDGER_STATE_FILTERS: readonly LedgerStateFilter[] = ["active", "all", "IN_PROGRESS", "REVIEW", "WIP", "DONE", "UNREGISTERED"];

const ACTIVE_STATES: ReadonlySet<string> = new Set(["IN_PROGRESS", "REVIEW", "WIP"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "ac.ledgerFilter";

export interface FilteredLedger {
  groups: LedgerGroups;
  /** 表示している件数 / 条件に合わず隠れた件数 / 条件に合うが日付を読めず期間で判定できない件数 */
  shown: number;
  hidden: number;
  unknownDate: number;
  total: number;
}

type Verdict = "shown" | "hidden" | "unknownDate";

/** 台帳の行の状態（行が無い・衝突は UNREGISTERED）。 */
function stateOf(card: LedgerCard): string {
  return card.result.kind === "found" ? card.result.state : "UNREGISTERED";
}

function matchesState(state: string, filter: LedgerStateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_STATES.has(state);
  return state === filter;
}

/** 各カードは「表示」「隠れ」「日付不明」のどれか 1 つに入る（合計は常に total と一致する）。 */
export function classify(card: LedgerCard, filter: LedgerFilter, now: number): Verdict {
  if (!matchesState(stateOf(card), filter.state)) return "hidden";
  const query = filter.query.trim().toLowerCase();
  if (query !== "" && !card.branch.toLowerCase().includes(query)) return "hidden";
  if (filter.period === "all") return "shown";
  if (card.result.kind !== "found" || card.result.startedAt === null) return "unknownDate";
  return now - card.result.startedAt <= Number(filter.period) * MS_PER_DAY ? "shown" : "hidden";
}

export function applyLedgerFilter(snapshot: LedgerSnapshot | null, filter: LedgerFilter, now: number): FilteredLedger {
  const groups = Object.fromEntries(LEDGER_COLUMNS.map((c) => [c, [] as LedgerCard[]])) as LedgerGroups;
  const counts: Record<Verdict, number> = { shown: 0, hidden: 0, unknownDate: 0 };
  for (const column of LEDGER_COLUMNS) {
    for (const card of snapshot?.groups[column] ?? []) {
      const verdict = classify(card, filter, now);
      counts[verdict] += 1;
      if (verdict === "shown") groups[column].push(card);
    }
  }
  return { groups, ...counts, total: counts.shown + counts.hidden + counts.unknownDate };
}

function isFilter(value: unknown): value is LedgerFilter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    LEDGER_PERIODS.includes(v.period as LedgerPeriod) &&
    LEDGER_STATE_FILTERS.includes(v.state as LedgerStateFilter) &&
    typeof v.query === "string"
  );
}

/** 閲覧者ごとの表示設定。読めなければ既定で動く。 */
export function loadLedgerFilter(): LedgerFilter {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_LEDGER_FILTER;
    const parsed: unknown = JSON.parse(raw);
    return isFilter(parsed) ? parsed : DEFAULT_LEDGER_FILTER;
  } catch {
    return DEFAULT_LEDGER_FILTER;
  }
}

export function saveLedgerFilter(filter: LedgerFilter): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // 保存できなくても絞り込みは効く（次回は既定に戻る）
  }
}
