import { describe, expect, it } from "vitest";
import { classifyLookupFailure, groupByState, isSafeLedgerBranch, loadLedger, parseBranchLine, parseLedgerRow, parseStartedAt } from "../../server/ledger.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("ledger parsing", () => {
  it("reads the branch from the first line", () => {
    expect(parseBranchLine("branch: release/x\n\n| a |")).toBe("release/x");
    expect(parseBranchLine("nothing")).toBeNull();
    expect(parseBranchLine("branch:    \n")).toBeNull();
  });

  it("takes the 4th column as the state", () => {
    const row = "| release/x | area | 2026-09-26 | IN_PROGRESS | | | note |";
    expect(parseLedgerRow(row)).toEqual({ branch: "release/x", state: "IN_PROGRESS", startedAtText: "2026-09-26" });
  });

  it("returns null for rows with fewer than 4 columns", () => {
    expect(parseLedgerRow("| a | b |")).toBeNull();
  });
});

describe("groupByState", () => {
  it("buckets known states and falls back to OTHER / UNREGISTERED", () => {
    const g = groupByState([
      { branch: "a", result: { kind: "found", state: "IN_PROGRESS", startedAt: null } },
      { branch: "b", result: { kind: "found", state: "REVIEW", startedAt: null } },
      { branch: "c", result: { kind: "found", state: "DONE", startedAt: null } },
      { branch: "d", result: { kind: "found", state: "ABANDONED", startedAt: null } },
      { branch: "e", result: { kind: "unregistered" } },
      { branch: "f", result: { kind: "conflict" } },
      { branch: "g", result: { kind: "error", message: "x" } },
    ]);
    expect(g.IN_PROGRESS.map((c) => c.branch)).toEqual(["a"]);
    expect(g.REVIEW.length).toBe(1);
    expect(g.DONE.length).toBe(1);
    expect(g.OTHER.map((c) => c.branch)).toEqual(["d"]);
    expect(g.UNREGISTERED.map((c) => c.branch)).toEqual(["e", "f"]);
  });
});

describe("classifyLookupFailure", () => {
  it("maps exit 1 to unregistered and exit 2 to conflict", () => {
    expect(classifyLookupFailure({ code: 1 })).toEqual({ kind: "unregistered" });
    expect(classifyLookupFailure({ code: 2 })).toEqual({ kind: "conflict" });
  });

  it("treats any other exit code as an error, not unregistered", () => {
    expect(classifyLookupFailure({ code: 127, stderr: "no such file" })).toEqual({ kind: "error", message: "exit 127: no such file" });
  });

  it("treats spawn failures and timeouts as errors", () => {
    expect(classifyLookupFailure({ code: "ENOENT", message: "spawn bash ENOENT" }).kind).toBe("error");
    expect(classifyLookupFailure({ killed: true, message: "timed out" }).kind).toBe("error");
  });
});

describe("isSafeLedgerBranch", () => {
  it.each(["release/abc", "feat/x.y_z-1"])("accepts %s", (b) => expect(isSafeLedgerBranch(b)).toBe(true));
  it.each(["-rf", "a b", "a;b", "$(x)", "../x", "a/../b", ""])("rejects %s", (b) => expect(isSafeLedgerBranch(b)).toBe(false));
});

describe("loadLedger", () => {
  function makeRoot(script: string | null): string {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ac-ledger-")));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "ledger"));
    writeFileSync(path.join(root, "ledger", "a.md"), "branch: release/a\n");
    writeFileSync(path.join(root, "ledger", "b.md"), "branch: -bad\n");
    if (script !== null) {
      writeFileSync(path.join(root, "scripts", "lookup.sh"), script);
      chmodSync(path.join(root, "scripts", "lookup.sh"), 0o755);
    }
    return root;
  }

  it("reports a missing lookup script as a ledger error and shows no unregistered cards", async () => {
    const root = makeRoot(null);
    const snap = await loadLedger(root, "ledger", "scripts/lookup.sh");
    expect(snap.errors.length).toBeGreaterThan(0);
    expect(snap.groups.UNREGISTERED).toEqual([]);
  });

  it("separates unsafe branch names and script failures from real results", async () => {
    const root = makeRoot('#!/bin/bash\nif [ "$1" = release/a ]; then echo "| release/a | x | d | IN_PROGRESS |"; exit 0; fi\nexit 9\n');
    const snap = await loadLedger(root, "ledger", "scripts/lookup.sh");
    expect(snap.groups.IN_PROGRESS.map((c) => c.branch)).toEqual(["release/a"]);
    expect(snap.errors.map((e) => e.branch)).toEqual(["-bad"]);
    expect(snap.groups.UNREGISTERED).toEqual([]);
  });

  it("runs no lookup script and reports an error when the main .git/commondir exists (ADR-1039 2b-2)", async () => {
    const mark = path.join(os.tmpdir(), `ac-ledger-mark-${process.pid}-${Date.now()}`);
    const root = makeRoot(`#!/bin/bash\ntouch ${mark}\necho "| release/a | x | d | IN_PROGRESS |"\n`);
    writeFileSync(path.join(root, ".git", "commondir"), "/nonexistent\n");
    const snap = await loadLedger(root, "ledger", "scripts/lookup.sh");
    expect(snap.groups.IN_PROGRESS.map((c) => c.branch)).not.toContain("release/a");
    expect(JSON.stringify(snap.errors)).toContain("main link check failed");
    expect(existsSync(mark)).toBe(false);
  });

  it("survives an unreadable ledger entry", async () => {
    const root = makeRoot('#!/bin/bash\nexit 1\n');
    mkdirSync(path.join(root, "ledger", "dir.md"));
    const snap = await loadLedger(root, "ledger", "scripts/lookup.sh");
    expect(snap.errors.some((e) => e.branch === "dir.md")).toBe(true);
  });
});

describe("parseStartedAt", () => {
  it("reads YYYY-MM-DD HH:MM as local time", () => {
    expect(parseStartedAt("2026-10-11 09:30")).toBe(new Date(2026, 9, 11, 9, 30).getTime());
  });
  it("returns null for other formats, wrong calendar dates and noise", () => {
    for (const text of ["20260920_010000", "2026-10-11", "2026-13-01 00:00", "2026-02-30 10:00", "", "abc | def", "2026-10-11T09:30"]) {
      expect(parseStartedAt(text)).toBeNull();
    }
  });
});
