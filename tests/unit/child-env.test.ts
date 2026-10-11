import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../server/sessions.ts";

describe("buildChildEnv", () => {
  it("removes AGENT_CONSOLE_TOKEN and keeps the rest", () => {
    const env = buildChildEnv({ PATH: "/bin", AGENT_CONSOLE_TOKEN: "secret", HOME: "/h" });
    expect(env.AGENT_CONSOLE_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
  });

  it("sets TERM and drops undefined values", () => {
    const env = buildChildEnv({ A: undefined, B: "1" });
    expect(env.TERM).toBe("xterm-256color");
    expect("A" in env).toBe(false);
  });

  it("K3: sets terminalEnv even when the source has no LANG (LaunchAgent state)", () => {
    const env = buildChildEnv({ PATH: "/bin" }, { LANG: "ja_JP.UTF-8" });
    expect(env.LANG).toBe("ja_JP.UTF-8");
  });

  it("terminalEnv overrides the parent value but never TERM or blocked keys", () => {
    const env = buildChildEnv({ LANG: "C" }, { LANG: "ja_JP.UTF-8", TERM: "dumb", AGENT_CONSOLE_TOKEN: "x" });
    expect(env.LANG).toBe("ja_JP.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.AGENT_CONSOLE_TOKEN).toBeUndefined();
  });
});
