import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { ApiError, fetchPr, refreshPr } from "../../api";
import type { CheckBucket, CheckItem, PrInfo, PrResponse } from "../../types";
import "./PrPane.css";

/** 保存済みの写しを読み直す間隔。サーバーの写しを読むだけで GitHub は呼ばない */
const RELOAD_MS = 5000;
const GITHUB_URL_PREFIX = "https://github.com/";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";
type PaneState = { kind: "data"; value: PrResponse } | { kind: "outside" } | { kind: "error" };

const COUNT_ORDER: ReadonlyArray<{ bucket: CheckBucket; variant: BadgeVariant }> = [
  { bucket: "pass", variant: "success" },
  { bucket: "fail", variant: "danger" },
  { bucket: "pending", variant: "info" },
  { bucket: "skipping", variant: "neutral" },
  { bucket: "cancel", variant: "warning" },
];
const COUNT_KEYS: Record<CheckBucket, string> = {
  pass: "ac.pr.count.pass",
  fail: "ac.pr.count.fail",
  pending: "ac.pr.count.pending",
  skipping: "ac.pr.count.skipping",
  cancel: "ac.pr.count.cancel",
};
const BUCKET_KEYS: Record<CheckItem["bucket"], string> = { fail: "ac.pr.bucket.fail", cancel: "ac.pr.bucket.cancel", pending: "ac.pr.bucket.pending" };
const BUCKET_VARIANTS: Record<CheckItem["bucket"], BadgeVariant> = { fail: "danger", cancel: "warning", pending: "info" };
const MERGE_KEYS: Record<string, string> = {
  CLEAN: "ac.pr.merge.CLEAN",
  HAS_HOOKS: "ac.pr.merge.HAS_HOOKS",
  UNSTABLE: "ac.pr.merge.UNSTABLE",
  BLOCKED: "ac.pr.merge.BLOCKED",
  BEHIND: "ac.pr.merge.BEHIND",
  DIRTY: "ac.pr.merge.DIRTY",
  DRAFT: "ac.pr.merge.DRAFT",
  UNKNOWN: "ac.pr.merge.UNKNOWN",
};
const REASON_KEYS = {
  ghMissing: "ac.pr.reason.ghMissing",
  authRequired: "ac.pr.reason.authRequired",
  timeout: "ac.pr.reason.timeout",
  rateLimited: "ac.pr.reason.rateLimited",
  ghFailed: "ac.pr.reason.ghFailed",
} as const;

/** 画面でも github.com 以外はリンクにしない（サーバー側でも同じ検査をしている） */
const isGithubUrl = (url: string): boolean => url.startsWith(GITHUB_URL_PREFIX);

interface Props {
  sessionId: string;
  /** 「PR」タブが開いているか（閉じている間は取得しない） */
  active: boolean;
}

function ExternalLink({ href, children }: { href: string; children: string }): ReactElement {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ac-pr__link">
      {children}
    </a>
  );
}

/** 「PR」タブの中身。正本は GitHub で、ここはサーバーが持つ写しを出すだけ。 */
export function PrPane({ sessionId, active }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<PaneState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const loadedFor = useRef<string | null>(null);

  const apply = useCallback((id: string, run: () => Promise<PrResponse>): Promise<void> => {
    return run().then(
      (value) => {
        if (sessionRef.current === id) setState({ kind: "data", value });
      },
      (err: unknown) => {
        if (sessionRef.current === id) setState(err instanceof ApiError && err.status === 409 ? { kind: "outside" } : { kind: "error" });
      },
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      setState(null);
    }
    void apply(sessionId, () => fetchPr(sessionId));
    const timer = setInterval(() => void apply(sessionId, () => fetchPr(sessionId)), RELOAD_MS);
    return () => clearInterval(timer);
  }, [sessionId, active, apply]);

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true);
    await apply(sessionId, () => refreshPr(sessionId));
    setRefreshing(false);
  };

  const message = (): ReactElement | null => {
    if (state === null) return <EmptyState size="compact" title={t("ac.pr.loading")} />;
    if (state.kind === "outside") return <EmptyState size="compact" title={t("ac.pr.outside")} description={t("ac.pr.outsideHint")} />;
    if (state.kind === "error") return <Callout variant="warning" title={t("ac.pr.errorTitle")}>{t("ac.pr.reason.fetchFailed")}</Callout>;
    const v = state.value;
    switch (v.status) {
      case "ok":
        return null;
      case "loading":
        return <EmptyState size="compact" title={t("ac.pr.loading")} />;
      case "noPr":
        return <EmptyState size="compact" title={t("ac.pr.noPr")} />;
      case "notGitHub":
        return <EmptyState size="compact" title={t("ac.pr.notGitHub")} />;
      case "detached":
        return <EmptyState size="compact" title={t("ac.pr.detached")} />;
      default:
        return (
          <Callout variant="warning" title={t("ac.pr.errorTitle")}>
            {t(REASON_KEYS[v.status])}
          </Callout>
        );
    }
  };

  const prState = (pr: PrInfo): { label: string; variant: BadgeVariant } => {
    if (pr.state === "MERGED") return { label: t("ac.pr.state.merged"), variant: "success" };
    if (pr.state === "CLOSED") return { label: t("ac.pr.state.closed"), variant: "neutral" };
    return pr.isDraft ? { label: t("ac.pr.state.draft"), variant: "neutral" } : { label: t("ac.pr.state.open"), variant: "info" };
  };

  const content = (): ReactElement | null => {
    if (state === null || state.kind !== "data" || state.value.status !== "ok") return null;
    const { pr, checks, fetchedAt } = state.value;
    const badge = prState(pr);
    const heading = `#${pr.number} ${pr.title}`;
    const total = Object.values(checks.counts).reduce((sum, n) => sum + n, 0);
    return (
      <>
        <div className="ac-pr__head">
          <span className="ac-pr__title" data-testid="pr-title">
            {isGithubUrl(pr.url) ? <ExternalLink href={pr.url}>{heading}</ExternalLink> : heading}
          </span>
          <span data-testid="pr-state">
            <Badge variant={badge.variant} size="sm">
              {badge.label}
            </Badge>
          </span>
          {pr.state === "OPEN" && (
            <span className="ac-pr__merge" data-testid="pr-merge">
              {t(MERGE_KEYS[pr.mergeStateStatus] ?? MERGE_KEYS.UNKNOWN)}
            </span>
          )}
          <span className="ac-pr__fetched">{t("ac.pr.fetchedAt", { time: new Date(fetchedAt).toLocaleTimeString("ja-JP") })}</span>
        </div>
        {total === 0 ? (
          <p className="ac-pr__none">{t("ac.pr.noChecks")}</p>
        ) : (
          <div className="ac-pr__counts" data-testid="pr-counts">
            {COUNT_ORDER.map(({ bucket, variant }) => (
              <Badge key={bucket} variant={variant} size="sm">
                {t(COUNT_KEYS[bucket], { count: checks.counts[bucket] })}
              </Badge>
            ))}
          </div>
        )}
        {checks.items.length > 0 && (
          <section className="ac-pr__checks" aria-label={t("ac.pr.checksTitle")}>
            <h3 className="ac-pr__checks-title">{t("ac.pr.checksTitle")}</h3>
            <ul className="ac-pr__list">
              {checks.items.map((item, i) => (
                <li key={`${item.name}-${i}`} className="ac-pr__check" data-testid="pr-check">
                  <Badge variant={BUCKET_VARIANTS[item.bucket]} size="sm">
                    {t(BUCKET_KEYS[item.bucket])}
                  </Badge>
                  <span className="ac-pr__check-name">{item.name}</span>
                  {item.workflow !== "" && <span className="ac-pr__check-workflow">{item.workflow}</span>}
                  {isGithubUrl(item.link) && <ExternalLink href={item.link}>{t("ac.pr.open")}</ExternalLink>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  };

  return (
    <div className="ac-pr" hidden={!active} data-testid="pr-pane">
      <div className="ac-pr__toolbar">
        <Button size="sm" variant="outline" layoutClassName="comp-btn-layout--ml-auto" disabled={refreshing} onClick={() => void handleRefresh()}>
          {refreshing ? t("ac.pr.refreshing") : t("ac.pr.refresh")}
        </Button>
      </div>
      <div className="ac-pr__body">
        {content()}
        <div data-testid="pr-message">{message()}</div>
      </div>
    </div>
  );
}
