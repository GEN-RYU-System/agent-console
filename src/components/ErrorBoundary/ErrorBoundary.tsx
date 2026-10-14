import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import "./ErrorBoundary.css";

function Fallback() {
  const { t } = useTranslation();
  return (
    <div className="ac-error-boundary">
      <Callout variant="warning" title={t("ac.errorBoundary.title")}>
        <p>{t("ac.errorBoundary.body")}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          {t("ac.errorBoundary.reload")}
        </Button>
      </Callout>
    </div>
  );
}

interface State {
  failed: boolean;
}

/** 描画の途中の例外で画面が真っ白にならないようにする。トークンは sessionStorage とサーバーに残るので、再読み込みでそのまま戻れる。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 原因調べ用にブラウザの Console へ。画面の内容・トークンは出さない
    console.error("render failed", error instanceof Error ? error.message : "unknown", info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
