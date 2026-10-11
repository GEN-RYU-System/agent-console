import { describe, expect, it } from "vitest";
import { classifyLookupFailure, groupByState, isSafeLedgerBranch, loadLedger, parseBranchLine, parseLedgerRow } from "../../server/ledger.ts";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
    expect(parseLedgerRow(row)).toEqual({ branch: "release/x", state: "IN_PROGRESS" });
  });

  it("returns null for rows with fewer than 4 columns", () => {
    expect(parseLedgerRow("| a | b |")).toBeNull();
  });
});

describe("groupByState", () => {
  it("buckets known states and falls back to OTHER / UNREGISTERED", () => {
    const g = groupByState([
      { branch: "a", result: { kind: "found", state: "IN_PROGRESS" } },
      { branch: "b", result: { kind: "found", state: "REVIEW" } },
      { branch: "c", result: { kind: "found", state: "DONE" } },
      { branch: "d", result: { kind: "found", state: "ABANDONED" } },
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

  it("survives an unreadable ledger entry", async () => {
    const root = makeRoot('#!/bin/bash\nexit 1\n');
    mkdirSync(path.join(root, "ledger", "dir.md"));
    const snap = await loadLedger(root, "ledger", "scripts/lookup.sh");
    expect(snap.errors.some((e) => e.branch === "dir.md")).toBe(true);
  });
});
