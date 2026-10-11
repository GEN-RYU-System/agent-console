// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./i18n";

vi.mock("./pages/ConsolePage", () => ({ ConsolePage: () => <div>console-page</div> }));
vi.mock("./api", () => ({ redeemCode: () => Promise.reject(new Error("401")), setSessionToken: () => undefined }));

afterEach(() => window.history.replaceState(null, "", "/"));

describe("App routing", () => {
  it("shows the pairing guidance on /pair", async () => {
    window.history.replaceState(null, "", "/pair?code=x");
    const { App } = await import("./App");
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("ペアリングできませんでした");
  });

  it("shows the console elsewhere", async () => {
    const { App } = await import("./App");
    render(<App />);
    expect(screen.getByText("console-page")).toBeTruthy();
  });
});
