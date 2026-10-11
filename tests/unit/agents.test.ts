import { describe, expect, it } from "vitest";
import { parseAgentsOutput, stateForSession } from "../../server/agents.ts";

describe("parseAgentsOutput", () => {
  it("parses a plain JSON array", () => {
    const rows = parseAgentsOutput('[{"pid":10,"status":"busy","name":"a","extra":1}]');
    expect(rows).toEqual([{ pid: 10, status: "busy", name: "a" }]);
  });

  it("strips ANSI escapes and CRLF", () => {
    const raw = '[\r\n{"pid":11,"status":"waiting"}\r\n]\u001b[?25h';
    expect(parseAgentsOutput(raw)).toEqual([{ pid: 11, status: "waiting", name: undefined }]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseAgentsOutput("not json")).toBeNull();
    expect(parseAgentsOutput('{"pid":1}')).toBeNull();
  });

  it("drops rows lacking a numeric pid", () => {
    expect(parseAgentsOutput('[{"status":"idle"},{"pid":"x"},{"pid":5,"status":"idle"}]')).toEqual([
      { pid: 5, status: "idle", name: undefined },
    ]);
  });

  it("maps unknown status values to unknown", () => {
    expect(parseAgentsOutput('[{"pid":5,"status":"zzz"}]')).toEqual([{ pid: 5, status: "unknown", name: undefined }]);
  });
});

describe("stateForSession", () => {
  const rows = [
    { pid: 100, status: "busy" as const },
    { pid: 200, status: "waiting" as const },
    { pid: 300, status: "idle" as const },
  ];
  it("maps statuses of descendant pids", () => {
    expect(stateForSession({ exited: false, pids: new Set([1, 100]) }, rows)).toBe("working");
    expect(stateForSession({ exited: false, pids: new Set([200]) }, rows)).toBe("waiting");
    expect(stateForSession({ exited: false, pids: new Set([300]) }, rows)).toBe("idle");
  });
  it("reports no-claude when nothing matches", () => {
    expect(stateForSession({ exited: false, pids: new Set([1]) }, rows)).toBe("no-claude");
  });
  it("reports stopped when the pty exited", () => {
    expect(stateForSession({ exited: true, pids: new Set([100]) }, rows)).toBe("stopped");
  });
  it("reports unknown when agents data is unavailable", () => {
    expect(stateForSession({ exited: false, pids: new Set([100]) }, null)).toBe("unknown");
  });
});
