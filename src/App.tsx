import { ConsolePage } from "./pages/ConsolePage";
import { PairingPage } from "./pages/PairingPage";

/** /pair はペアリングコードの引換え画面（失敗時は案内の Callout）。それ以外はコンソール。 */
export function App() {
  return window.location.pathname === "/pair" ? <PairingPage /> : <ConsolePage />;
}
