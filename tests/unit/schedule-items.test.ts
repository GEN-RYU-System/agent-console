import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionInputError, SessionNotFoundError } from "../../server/sessions.ts";
import { SCHEDULE_FILE, ScheduleItemService, ScheduleItemStore, type ScheduleItem } from "../../server/schedule-items.ts";

const setup = (now = { t: 1_000 }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-sched-"));
  const store = new ScheduleItemStore(dir);
  const service = new ScheduleItemService(store, () => now.t);
  return { dir, store, service, now, file: path.join(dir, SCHEDULE_FILE) };
};
const base = { side: "secretary", kind: "todo", title: "task", date: "2026-11-04" };

describe("ScheduleItemService", () => {
  it("saves and reads back", async () => {
    const { service, file } = setup();
    const item = await service.create({ ...base, start: "10:00", end: "11:00", note: "memo" }, "ui");
    expect(item.id).toMatch(/^sch_[a-z0-9]{12}$/);
    expect(item).toMatchObject({ status: "open", createdBy: "ui", start: "10:00", end: "11:00", note: "memo" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, items: [{ id: item.id }] });
    expect(await service.list("2026-11-01", "2026-11-30")).toEqual([item]);
    expect(await service.list("2026-12-01", "2026-12-31")).toEqual([]);
  });

  it("list returns items without a date and done items too", async () => {
    const { service } = setup();
    const undated = await service.create({ side: "dev", kind: "todo", title: "anytime" }, "ui");
    const done = await service.create(base, "ui");
    await service.update(done.id, { status: "done" });
    const out = await service.list("2026-11-01", "2026-11-30");
    expect(out.map((i) => i.id).sort()).toEqual([undated.id, done.id].sort());
  });

  it("does not overwrite a broken file or an unknown version", async () => {
    const a = setup();
    writeFileSync(a.file, "{broken");
    await expect(a.service.create(base, "ui")).rejects.toThrow();
    expect(readFileSync(a.file, "utf8")).toBe("{broken");
    const b = setup();
    const v2 = JSON.stringify({ version: 2, items: [] });
    writeFileSync(b.file, v2);
    await expect(b.service.create(base, "ui")).rejects.toThrow(/unsupported/);
    expect(readFileSync(b.file, "utf8")).toBe(v2);
  });

  it("rejects nonexistent dates and times with 400-class errors", async () => {
    const { service } = setup();
    await expect(service.create({ ...base, date: "2026-02-30" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, start: "25:00" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, start: "9:00" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, title: "" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, title: "a\u0007b" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, side: "x" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
  });

  it("rejects end <= start and end without start", async () => {
    const { service } = setup();
    await expect(service.create({ ...base, start: "10:00", end: "10:00" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, start: "10:00", end: "09:00" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
    await expect(service.create({ ...base, end: "11:00" }, "ui")).rejects.toBeInstanceOf(SessionInputError);
  });

  it("allows waitingOn only for waiting items", async () => {
    const { service } = setup();
    const w = await service.create({ ...base, kind: "waiting", waitingOn: "Taro" }, "ui");
    const t = await service.create({ ...base, waitingOn: "Taro" }, "ui");
    expect(w.waitingOn).toBe("Taro");
    expect(t.waitingOn).toBeUndefined();
  });

  it("refuses the 301st open item", async () => {
    const { dir, service } = setup();
    const items: ScheduleItem[] = Array.from({ length: 300 }, (_, i) => ({ id: `sch_${String(i).padStart(12, "0")}`, side: "dev", kind: "todo", title: `t${i}`, status: "open", createdBy: "ui", createdAt: 1, updatedAt: 1 }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, SCHEDULE_FILE), JSON.stringify({ version: 1, items }));
    await expect(service.create(base, "ui")).rejects.toThrow("schedule open limit");
  });

  it("prunes the oldest done items beyond 1000", async () => {
    const { dir, service, file } = setup();
    const items: ScheduleItem[] = Array.from({ length: 1000 }, (_, i) => ({ id: `sch_${String(i).padStart(12, "0")}`, side: "dev", kind: "todo", title: `t${i}`, status: "done", createdBy: "ui", createdAt: 1, updatedAt: 1, doneAt: 100 + i }));
    writeFileSync(path.join(dir, SCHEDULE_FILE), JSON.stringify({ version: 1, items }));
    const added = await service.create(base, "ui");
    const saved = (JSON.parse(readFileSync(file, "utf8")) as { items: ScheduleItem[] }).items;
    expect(saved).toHaveLength(1000);
    expect(saved.some((i) => i.id === "sch_000000000000")).toBe(false);
    expect(saved.some((i) => i.id === "sch_000000000001")).toBe(true);
    expect(saved.some((i) => i.id === added.id)).toBe(true);
  });

  it("sets doneAt on done and clears it on reopen", async () => {
    const { service, now } = setup();
    const item = await service.create(base, "ui");
    now.t = 5_000;
    const done = await service.update(item.id, { status: "done" });
    expect(done).toMatchObject({ status: "done", doneAt: 5_000, updatedAt: 5_000 });
    now.t = 6_000;
    const open = await service.update(item.id, { status: "open" });
    expect(open.status).toBe("open");
    expect(open.doneAt).toBeUndefined();
    expect(await service.update(item.id, { title: "renamed", start: "10:00" })).toMatchObject({ title: "renamed", start: "10:00" });
  });

  it("removes and reports unknown ids as not found", async () => {
    const { service } = setup();
    const item = await service.create(base, "ui");
    await service.remove(item.id);
    expect(await service.list("2026-11-01", "2026-11-30")).toEqual([]);
    await expect(service.remove(item.id)).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(service.update("sch_nope", { title: "x" })).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
