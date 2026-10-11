// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import { ThemeToggle } from "./ThemeToggle";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("force-dark");
});

describe("ThemeToggle", () => {
  it("switches <html> to dark, stores it, and offers the way back", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "ダークモード" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(document.documentElement.classList.contains("force-dark")).toBe(true);
    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "ライトモード" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "ライトモード" }));
    expect(document.documentElement.classList.contains("force-dark")).toBe(false);
    expect(window.localStorage.getItem("theme")).toBe("light");
  });

  it("starts pressed when dark was stored", () => {
    window.localStorage.setItem("theme", "dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "ライトモード" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not write cookies", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "ダークモード" }));
    expect(document.cookie).toBe("");
  });
});
