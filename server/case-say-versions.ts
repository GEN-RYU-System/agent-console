// 件の claude の版の記録（設計 Sales Anchor docs/handoff/conversation-consent/design.md §14-14-3 D5・§14-14-6 の 1）。
// 書き手はサーバーだけ。項目ごとに MAC を付ける。壊れた記録・MAC の合わない項目は使わず、上書きもしない（書き込みを止める）。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream, statSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-store.ts";

export const CASE_SAY_VERSIONS_FILE = "case-say-claude-versions.json";
export const CASE_SAY_VERSIONS_KEY_FILE = "case-say-claude-versions.key";
const KEY_MODE = 0o600;
const KEY_BYTES = 32;
export const FINGERPRINT_TIMEOUT_MS = 60_000;

export interface Fingerprint {
  size: number;
  sha256: string;
}

/** 実体を流し読みして sha256・size を取る（サーバーを止めない）。読めない・時間切れは null */
export function fingerprintFile(file: string, timeoutMs = FINGERPRINT_TIMEOUT_MS): Promise<Fingerprint | null> {
  return new Promise((resolve) => {
    let settled = false;
    const hash = createHash("sha256");
    let size = 0;
    const stream = createReadStream(file);
    const done = (value: Fingerprint | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on("error", () => done(null));
    stream.on("end", () => done({ size, sha256: hash.digest("hex") }));
  });
}

export type CheckId = "E1" | "E2" | "E3" | "E4" | "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "R1";

export interface VersionEntry {
  sha256: string;
  size: number;
  claudeVersion: string;
  real: string;
  verifiedAt: string;
  probeCaseId: string;
  checks: Record<string, boolean>;
  usable: boolean;
  lastProbeAt: string;
  /** "ok" / ×の番号 / "aborted" / "audit_failed" / "revoked" */
  lastResult: string;
  failCount: number;
  mac: string;
}

export interface RunningVersionProbe {
  caseId: string;
  startedAt: number;
  /** 起動時の片付けが監査・記録に使う（実装の選択。設計の形に足した任意の欄） */
  sha256?: string;
  claudeVersion?: string;
}

export type VersionNoticeReason = "n1" | "n2" | "n3" | "n4" | "n5" | "n6";

const hex = (v: unknown, len: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${len}}$`).test(v);

function macBody(e: Omit<VersionEntry, "mac">): string {
  return JSON.stringify([e.sha256, e.size, e.claudeVersion, e.real, e.verifiedAt, e.probeCaseId, Object.entries(e.checks).sort(([a], [b]) => a.localeCompare(b)), e.usable, e.lastProbeAt, e.lastResult, e.failCount]);
}

function parseEntry(raw: unknown): Omit<VersionEntry, "mac"> & { mac: string } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hex(o.sha256, 64) || typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 0) return null;
  if (typeof o.claudeVersion !== "string" || typeof o.real !== "string" || typeof o.verifiedAt !== "string" || typeof o.probeCaseId !== "string") return null;
  if (typeof o.usable !== "boolean" || typeof o.lastProbeAt !== "string" || typeof o.lastResult !== "string") return null;
  if (typeof o.failCount !== "number" || !Number.isInteger(o.failCount) || o.failCount < 0 || typeof o.mac !== "string") return null;
  const checks: Record<string, boolean> = {};
  if (typeof o.checks !== "object" || o.checks === null || Array.isArray(o.checks)) return null;
  for (const [k, v] of Object.entries(o.checks)) {
    if (typeof v !== "boolean") return null;
    checks[k] = v;
  }
  return { sha256: o.sha256, size: o.size, claudeVersion: o.claudeVersion, real: o.real, verifiedAt: o.verifiedAt, probeCaseId: o.probeCaseId, checks, usable: o.usable, lastProbeAt: o.lastProbeAt, lastResult: o.lastResult, failCount: o.failCount, mac: o.mac };
}

export interface LoadReport {
  /** 記録が読めない・MAC の合わない項目を捨てた・鍵が作れなかった（D1 n5） */
  discarded: boolean;
}

/**
 * dataDir の記録「case-say-claude-versions.json」の持ち主。起動時に load() し、判定 4b はメモリの写しで決める（同期）。
 * 読めない・MAC が合わない項目があったときは locked にして上書きしない（PO が記録を退避して起き直すまで書かない）。
 */
export class CaseSayVersionStore {
  private readonly file: string;
  private readonly keyFile: string;
  private key: Buffer | null = null;
  private items: VersionEntry[] = [];
  private running: RunningVersionProbe | undefined;
  private lockedWrites = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, CASE_SAY_VERSIONS_FILE);
    this.keyFile = path.join(dataDir, CASE_SAY_VERSIONS_KEY_FILE);
  }

  /** 鍵（無ければ 0600 で作る）と記録を読む。投げない */
  async load(): Promise<LoadReport> {
    let discarded = false;
    this.items = [];
    this.running = undefined;
    this.lockedWrites = false;
    try {
      this.key = await this.readOrCreateKey();
    } catch {
      this.key = null;
      this.lockedWrites = true;
      return { discarded: true };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(this.file);
    } catch {
      this.lockedWrites = true;
      return { discarded: true };
    }
    if (raw === undefined) return { discarded: false };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.lockedWrites = true;
      return { discarded: true };
    }
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1 || !Array.isArray(doc.entries)) {
      this.lockedWrites = true;
      return { discarded: true };
    }
    for (const rawEntry of doc.entries) {
      const parsed = parseEntry(rawEntry);
      if (parsed === null || !this.macOk(parsed)) {
        discarded = true;
        continue;
      }
      this.items.push(parsed);
    }
    const run = doc.runningVersionProbe;
    if (typeof run === "object" && run !== null && !Array.isArray(run)) {
      const r = run as Record<string, unknown>;
      if (typeof r.caseId === "string" && typeof r.startedAt === "number") {
        this.running = { caseId: r.caseId, startedAt: r.startedAt, ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}), ...(typeof r.claudeVersion === "string" ? { claudeVersion: r.claudeVersion } : {}) };
      }
    }
    if (discarded) this.lockedWrites = true;
    return { discarded };
  }

  private async readOrCreateKey(): Promise<Buffer> {
    try {
      const text = (await readFile(this.keyFile, "utf8")).trim();
      if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
      throw new Error("key file is damaged");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const fresh = randomBytes(KEY_BYTES);
    await writeFile(this.keyFile, `${fresh.toString("hex")}\n`, { mode: KEY_MODE, flag: "wx" });
    await chmod(this.keyFile, KEY_MODE);
    return fresh;
  }

  private macOf(e: Omit<VersionEntry, "mac">): string {
    if (this.key === null) return "";
    return createHmac("sha256", this.key).update(macBody(e)).digest("hex");
  }

  private macOk(e: VersionEntry): boolean {
    if (this.key === null) return false;
    const want = Buffer.from(this.macOf(e), "hex");
    const got = Buffer.from(e.mac, "hex");
    return want.length === got.length && want.length > 0 && timingSafeEqual(want, got);
  }

  /** 書き込みが止まっているか（記録が読めない・捨てた項目がある・鍵が無い） */
  isLocked(): boolean {
    return this.lockedWrites || this.key === null;
  }

  entries(): readonly VersionEntry[] {
    return this.items;
  }

  entryOf(sha256: string): VersionEntry | undefined {
    return this.items.find((e) => e.sha256 === sha256);
  }

  /** 判定 4b（記録のとき）: 指紋が使える項目と一致する */
  isUsable(fp: Fingerprint | undefined): boolean {
    if (fp === undefined) return false;
    return this.items.some((e) => e.usable && e.sha256 === fp.sha256 && e.size === fp.size);
  }

  /** 使える項目の版の名前（画面用） */
  usableVersions(): string[] {
    return [...new Set(this.items.filter((e) => e.usable).map((e) => e.claudeVersion))];
  }

  runningVersionProbe(): RunningVersionProbe | undefined {
    return this.running;
  }

  /** 項目を差し替える（同じ sha256 は置き換え）。MAC を付けて書く。書けなければ false（メモリも変えない） */
  async upsert(entry: Omit<VersionEntry, "mac">): Promise<boolean> {
    if (this.isLocked()) return false;
    const full: VersionEntry = { ...entry, mac: this.macOf(entry) };
    const next = [...this.items.filter((e) => e.sha256 !== entry.sha256), full];
    return this.persist(next, this.running, () => { this.items = next; });
  }

  async setRunning(run: RunningVersionProbe | undefined): Promise<boolean> {
    if (this.isLocked()) return false;
    return this.persist(this.items, run, () => { this.running = run; });
  }

  /** 項目を usable: false にする（消さない）。無ければ何もしない */
  async revoke(sha256: string, lastResult: string, at: string): Promise<boolean> {
    const found = this.entryOf(sha256);
    if (found === undefined) return true;
    const { mac: _mac, ...rest } = found;
    const written = await this.upsert({ ...rest, usable: false, lastResult, lastProbeAt: at });
    // 書けなくても、メモリでは必ず使えなくする（実体が変わったのに通さない）
    if (!written) this.items = this.items.map((e) => (e.sha256 === sha256 ? { ...e, usable: false, lastResult, lastProbeAt: at } : e));
    return true;
  }

  private persist(items: VersionEntry[], running: RunningVersionProbe | undefined, commit: () => void): Promise<boolean> {
    const job = this.chain.catch(() => undefined).then(async () => {
      try {
        await writeJsonAtomic(this.file, { version: 1, entries: items, ...(running !== undefined ? { runningVersionProbe: running } : {}) });
        commit();
        return true;
      } catch {
        return false;
      }
    });
    this.chain = job;
    return job;
  }

  /**
   * 起動時の再確認（軽い方）。使える各項目の実体を stat・sha256 し直し、無い・違えば usable: false にする。
   * 変えた項目を返す
   */
  async recheck(now: () => string, fingerprint: (file: string) => Promise<Fingerprint | null> = fingerprintFile): Promise<VersionEntry[]> {
    const revoked: VersionEntry[] = [];
    for (const e of [...this.items.filter((x) => x.usable)]) {
      let ok = false;
      try {
        if (statSync(e.real).isFile()) {
          accessSync(e.real, fsConstants.X_OK);
          const fp = await fingerprint(e.real);
          ok = fp !== null && fp.sha256 === e.sha256 && fp.size === e.size;
        }
      } catch {
        ok = false;
      }
      if (ok) continue;
      if (await this.revoke(e.sha256, "revoked", now())) {
        const after = this.entryOf(e.sha256);
        if (after !== undefined) revoked.push(after);
      }
    }
    return revoked;
  }
}
