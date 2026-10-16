import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../fixtures/e2e-env";
import { newPairingCode } from "../fixtures/e2e-pairing";

const MAC_ONLY_REASON = "計測は macOS の memory_pressure・sysctl・statfs に依存。agent-console は Mac 専用";
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BEARER = { Authorization: `Bearer ${E2E_TOKEN}`, Connection: "close" };
const DATA_DIR = process.env.AC_E2E_DATA_DIR as string;
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const USAGE_COMMAND = path.join(DATA_DIR, "bin", "ac-statusline.mjs");
/** 証拠の保存先。指定したときだけスクリーンショットと数値を保存する */
const EVIDENCE_DIR = process.env.AC_PCMETER_EVIDENCE_DIR;

interface MemoryBody {
  system: { cpuPercent: number | null; usedPercent: number | null; diskUsedPercent: number | null; diskTotalGb: number | null };
}

async function openPaired(page: Page): Promise<void> {
  await page.goto(`${BASE}/pair?code=${await newPairingCode()}`);
  await expect(page.getByRole("button", { name: "新しいセッション", exact: true })).toBeVisible();
}

async function fetchMemory(): Promise<MemoryBody> {
  const res = await fetch(`${BASE}/api/memory`, { headers: BEARER });
  expect(res.status).toBe(200);
  return (await res.json()) as MemoryBody;
}

function fireStatusline(): void {
  const now = Math.floor(Date.now() / 1000);
  const input = { rate_limits: { five_hour: { used_percentage: 23, resets_at: now + 10800 }, seven_day: { used_percentage: 41, resets_at: now + 216000 } } };
  execFileSync(process.execPath, [USAGE_COMMAND], { input: JSON.stringify(input), encoding: "utf8" });
}

function save(name: string, body: unknown): void {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

test("MacMeter: K1 Claude 欄と上端がそろう / K6 高さ・はみ出し・空き幅（1400・1024 × ライト・ダーク）", async ({ page }) => {
  test.skip(process.platform !== "darwin", MAC_ONLY_REASON);
  rmSync(USAGE_FILE, { force: true });
  try {
    fireStatusline();
    await openPaired(page);
    const footer = page.getByTestId("footer");
    await expect(footer.getByTestId("mac-meter")).toBeVisible();
    await expect(footer.getByTestId("mac-meter-bar-disk")).toBeVisible();
    const results: Array<Record<string, number | string>> = [];
    for (const width of [1400, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ["dark", "light"]) {
        // 現在のテーマと違うときだけ切り替える
        const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
        if ((theme === "dark") !== isDark) await page.getByTestId("footer-meta").getByRole("button", { name: /ダークモード|ライトモード/ }).click();
        await expect(page.getByTestId("mac-meter-bar-disk")).toBeVisible();
        const box = async (loc: ReturnType<Page["getByTestId"]>) => {
          const b = await loc.boundingBox();
          if (b === null) throw new Error("boundingBox が取れません");
          return b;
        };
        const f = await box(footer);
        const claude = await box(page.getByTestId("provider-claude"));
        const mac = await box(page.getByTestId("mac-meter"));
        const bars = [] as number[];
        for (const id of ["cpu", "ram", "disk"]) {
          const b = await box(page.getByTestId(`mac-meter-bar-${id}`));
          bars.push(b.x + b.width - (mac.x + mac.width));
        }
        const row: Record<string, number | string> = {
          viewport: `${width}x800`,
          theme,
          K1_macTop_minus_claudeTop: mac.y - claude.y,
          K6_footerHeight: f.height,
          K6_barRight_minus_macRight_max: Math.max(...bars),
          K6_gap_claudeRight_to_macLeft: mac.x - (claude.x + claude.width),
        };
        results.push(row);
        if (EVIDENCE_DIR) {
          mkdirSync(EVIDENCE_DIR, { recursive: true });
          await footer.screenshot({ path: path.join(EVIDENCE_DIR, `footer-${width}-${theme}.png`) });
        }
        expect(Math.abs(mac.y - claude.y)).toBeLessThanOrEqual(4);
        expect(f.height).toBeLessThanOrEqual(200);
        expect(Math.max(...bars)).toBeLessThanOrEqual(0);
        if (width === 1400) expect(mac.x - (claude.x + claude.width)).toBeGreaterThanOrEqual(600);
      }
    }
    save("k1-k6.json", results);
  } finally {
    rmSync(USAGE_FILE, { force: true });
  }
});

test("MacMeter: K2 Disk は statfs と ±0.5 / K3 RAM は memory_pressure と ±1 / K4 CPU は top と ±15（3 回）", async () => {
  test.skip(process.platform !== "darwin", MAC_ONLY_REASON);
  // CPU は定期計測の窓で出るので、最初の値が付くまで待つ
  await expect.poll(async () => (await fetchMemory()).system.cpuPercent, { timeout: 20000 }).not.toBeNull();
  const out: Record<string, unknown> = {};

  const s = statfsSync("/System/Volumes/Data");
  const diskRef = ((s.blocks - s.bavail) / s.blocks) * 100;
  const mem = await fetchMemory();
  out.K2 = { api: mem.system.diskUsedPercent, statfs: diskRef };
  expect(Math.abs((mem.system.diskUsedPercent as number) - diskRef)).toBeLessThanOrEqual(0.5);

  const mp = execFileSync("memory_pressure", { encoding: "utf8" });
  const free = Number(/free percentage:\s*(\d+)%/.exec(mp)?.[1]);
  const mem2 = await fetchMemory();
  out.K3 = { api_usedPercent: mem2.system.usedPercent, memory_pressure_100_minus_free: 100 - free };
  expect(Math.abs((mem2.system.usedPercent as number) - (100 - free))).toBeLessThanOrEqual(1);

  const k4: Array<Record<string, number>> = [];
  for (let i = 0; i < 3; i++) {
    const top = execFileSync("top", ["-l", "2", "-n", "0", "-s", "2"], { encoding: "utf8" });
    const idle = [...top.matchAll(/CPU usage:.*?([\d.]+)% idle/g)].map((m) => Number(m[1])).pop() as number;
    const api = (await fetchMemory()).system.cpuPercent as number;
    k4.push({ api, top_100_minus_idle: 100 - idle });
    expect(api).toBeGreaterThanOrEqual(0);
    expect(api).toBeLessThanOrEqual(100);
    expect(Math.abs(api - (100 - idle))).toBeLessThanOrEqual(15);
  }
  out.K4 = k4;
  save("k2-k3-k4.json", out);
});
