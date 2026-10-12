// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it("shows the translated label and exposes the state", () => {
    render(<StatusDot state="working" />);
    expect(screen.getByTestId("status").getAttribute("data-state")).toBe("working");
    expect(screen.getByText("作業中")).toBeTruthy();
  });

  it("labels a stopped session as stopped", () => {
    render(<StatusDot state="stopped" />);
    expect(screen.getByText("停止")).toBeTruthy();
  });

  it("v0.10.0 K5: with showLabel={false} it shows only the dot but keeps data-testid and data-state", () => {
    render(<StatusDot state="idle" showLabel={false} />);
    const el = screen.getByTestId("status");
    expect(el.getAttribute("data-state")).toBe("idle");
    expect(el.textContent).toBe("");
    expect(el.querySelector(".ac-status__dot--idle")).toBeTruthy();
  });
});
