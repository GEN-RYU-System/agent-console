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
});
