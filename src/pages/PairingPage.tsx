import { useEffect, useState } from "react";
import { redeemCode, setSessionToken } from "../api";
import { ConsolePage } from "./ConsolePage";
import { PairingFailedPage } from "./PairingFailedPage";

// StrictMode で effect が 2 回走っても、1 回限りのコードを 1 度しか引換えない
const inflight = new Map<string, Promise<string>>();

function redeemOnce(code: string): Promise<string> {
  const existing = inflight.get(code);
  if (existing) return existing;
  const created = redeemCode(code);
  inflight.set(code, created);
  return created;
}

type Status = "pending" | "ok" | "failed";

/** /pair?code=…: コードを引換えてセッショントークンを sessionStorage に保存し、URL を / に置き換えてコンソールを開く。 */
export function PairingPage() {
  const [status, setStatus] = useState<Status>("pending");

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code") ?? "";
    if (code === "") {
      setStatus("failed");
      return;
    }
    redeemOnce(code).then(
      (token) => {
        setSessionToken(token);
        window.history.replaceState(null, "", "/");
        setStatus("ok");
      },
      () => setStatus("failed"),
    );
  }, []);

  if (status === "ok") return <ConsolePage />;
  if (status === "failed") return <PairingFailedPage />;
  return null;
}
