import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { fetchAccount } from "../../api";
import type { AccountResponse } from "../../types";
import "./AccountBadge.css";

export const ACCOUNT_REFRESH_MS = 60000;

interface Props {
  /** 増えるたびに今すぐ取り直す（アカウント切り替えの端末が終わったとき） */
  refreshKey: number;
  /** 切り替えボタンを出すか（サーバーの accountSwitchEnabled） */
  switchEnabled: boolean;
  /** 切り替えボタンを押したとき（確認ダイアログは呼び出し側） */
  onSwitch: () => void;
}

/** 下の帯に出す、この Mac に保存された Claude ログイン（メール・プラン）。60 秒ごとに Claude Code へ聞き直す（保存しない）。 */
export function AccountBadge({ refreshKey, switchEnabled, onSwitch }: Props) {
  const { t } = useTranslation();
  const [account, setAccount] = useState<AccountResponse | null>(null);

  useEffect(() => {
    let closed = false;
    const load = (): void => {
      fetchAccount().then(
        (a) => {
          if (!closed) setAccount(a);
        },
        () => {
          if (!closed) setAccount({ status: "error" });
        },
      );
    };
    load();
    const timer = setInterval(load, ACCOUNT_REFRESH_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [refreshKey]);

  return (
    <div className="ac-account" data-testid="account-badge">
      {account === null ? null : account.status === "ok" && account.loggedIn ? (
        <span className="ac-account__info" title={t("ac.account.hint")}>
          <span className="ac-account__label">{t("ac.account.label")}:</span>
          <span className="ac-account__email" data-testid="account-email">
            {account.email}
          </span>
          <span data-testid="account-plan">
            <Badge variant="neutral" size="sm">
              {account.subscriptionType}
            </Badge>
          </span>
        </span>
      ) : (
        <span className="ac-account__label" data-testid="account-message" title={t("ac.account.hint")}>
          {account.status === "ok" ? t("ac.account.loggedOut") : t("ac.account.error")}
        </span>
      )}
      {switchEnabled && (
        <span data-testid="account-switch">
          <Button variant="ghost" size="sm" onClick={onSwitch}>
            {t("ac.account.switch")}
          </Button>
        </span>
      )}
    </div>
  );
}
