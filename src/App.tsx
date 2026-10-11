import { ConsolePage } from "./pages/ConsolePage";
import { PairingFailedPage } from "./pages/PairingFailedPage";

/** サーバーは無効なペアリングコードに対して /pair を 401 で返す。その場合は案内画面を出す。 */
export function App() {
  return window.location.pathname === "/pair" ? <PairingFailedPage /> : <ConsolePage />;
}
