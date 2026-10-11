// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../i18n";
import { PairingFailedPage } from "./PairingFailedPage";

describe("PairingFailedPage", () => {
  it("explains the failure in a warning callout", () => {
    render(<PairingFailedPage />);
    expect(screen.getByRole("alert").textContent).toContain("ペアリングできませんでした");
    expect(screen.getByRole("alert").textContent).toContain("Dock の Agent Console アプリ");
  });
});
