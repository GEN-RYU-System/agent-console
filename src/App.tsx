import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { ConsolePage } from "./pages/ConsolePage";
import { PairingPage } from "./pages/PairingPage";

/** /pair はペアリングコードの引換え画面（失敗時は案内の Callout）。それ以外はコンソール。描画の例外では白くせず案内を出す。 */
export function App() {
  return <ErrorBoundary>{window.location.pathname === "/pair" ? <PairingPage /> : <ConsolePage />}</ErrorBoundary>;
}
