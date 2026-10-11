// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readStoredTheme, storeTheme, THEME_STORAGE_KEY } from "./theme";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("force-dark");
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("defaults to light when nothing is stored", () => {
    expect(readStoredTheme()).toBe("light");
  });

  it("reads back what was stored, under the SA key", () => {
    storeTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(THEME_STORAGE_KEY).toBe("theme");
    expect(readStoredTheme()).toBe("dark");
  });

  it("treats an unknown stored value as light", () => {
    window.localStorage.setItem("theme", "sepia");
    expect(readStoredTheme()).toBe("light");
  });

  it("toggles the force-dark class on <html>", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("force-dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("force-dark")).toBe(false);
  });

  it("falls back to light and does not throw when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredTheme()).toBe("light");
    expect(() => storeTheme("dark")).not.toThrow();
  });

  it("never writes document.cookie", () => {
    storeTheme("dark");
    applyTheme("dark");
    expect(document.cookie).toBe("");
  });
});
