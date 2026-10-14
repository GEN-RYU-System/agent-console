import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs } from "@sa/components/Tabs";
import type { LedgerSnapshot } from "../../types";
import { ActivityPane } from "../ActivityPane/ActivityPane";
import { LedgerBoard } from "../LedgerBoard/LedgerBoard";
import { RoutineApprovalBar } from "./RoutineApprovalBar";
import "./RightPane.css";

type RightTab = "session" | "ledger";

interface Props {
  /** 選んでいるセッション（無ければ null。そのときは「台帳」だけ） */
  sessionId: string | null;
  /** セッションの様子の記録の版 */
  rev: number;
  ledger: LedgerSnapshot | null;
  onRefresh: () => void;
}

/** 右の欄。セッションを選ぶと「このセッション」と「台帳」のタブが出て、「このセッション」が先に開く。 */
export function RightPane({ sessionId, rev, ledger, onRefresh }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RightTab>("session");
  // 別のセッションを選んだら、また「このセッション」を先に開く
  useEffect(() => setTab("session"), [sessionId]);

  const items = [...(sessionId !== null ? [{ key: "session" as const, label: t("ac.rightTabs.session") }] : []), { key: "ledger" as const, label: t("ac.rightTabs.ledger") }];
  const active: RightTab = sessionId === null ? "ledger" : tab;
  return (
    <div className="ac-right">
      <Tabs variant="underline" size="sm" activeKey={active} onChange={setTab} items={items} />
      {active === "session" && sessionId !== null && <RoutineApprovalBar sessionId={sessionId} />}
      <div className="ac-right__body">
        {active === "session" && sessionId !== null ? <ActivityPane sessionId={sessionId} rev={rev} /> : <LedgerBoard snapshot={ledger} onRefresh={onRefresh} />}
      </div>
    </div>
  );
}
