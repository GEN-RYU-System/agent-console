// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";

const redeemCode = vi.fn();
const setSessionToken = vi.fn();

vi.mock("../api", () => ({ redeemCode: (c: string) => redeemCode(c), setSessionToken: (t: string) => setSessionToken(t) }));
vi.mock("./ConsolePage", () => ({ ConsolePage: () => <div>console-page</div> }));

beforeEach(() => {
  redeemCode.mockReset();
  setSessionToken.mockReset();
  window.history.replaceState(null, "", "/pair?code=code-1");
});

describe("PairingPage", () => {
  it("redeems the code once, stores the token, replaces the URL with / and opens the console", async () => {
    redeemCode.mockResolvedValue("tok");
    const { PairingPage } = await import("./PairingPage");
    render(<PairingPage />);
    expect(await screen.findByText("console-page")).toBeTruthy();
    expect(setSessionToken).toHaveBeenCalledWith("tok");
    expect(window.location.pathname + window.location.search).toBe("/");
    expect(redeemCode).toHaveBeenCalledTimes(1);
  });

  it("does not redeem twice under StrictMode double effects", async () => {
    window.history.replaceState(null, "", "/pair?code=strict-code");
    redeemCode.mockResolvedValue("tok");
    const React = await import("react");
    const { PairingPage } = await import("./PairingPage");
    render(
      <React.StrictMode>
        <PairingPage />
      </React.StrictMode>,
    );
    await screen.findByText("console-page");
    expect(redeemCode).toHaveBeenCalledTimes(1);
  });

  it("shows the guidance callout when the code is invalid, and keeps no token", async () => {
    window.history.replaceState(null, "", "/pair?code=bad");
    redeemCode.mockRejectedValue(new Error("401"));
    const { PairingPage } = await import("./PairingPage");
    render(<PairingPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("ペアリングできませんでした");
    expect(setSessionToken).not.toHaveBeenCalled();
  });

  it("shows the guidance callout when there is no code at all", async () => {
    window.history.replaceState(null, "", "/pair");
    const { PairingPage } = await import("./PairingPage");
    render(<PairingPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(redeemCode).not.toHaveBeenCalled();
  });
});
