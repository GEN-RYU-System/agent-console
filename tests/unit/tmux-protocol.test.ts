import { describe, expect, it } from "vitest";
import {
  buildReplay,
  classifyHasSession,
  CommandQueue,
  commonArgs,
  ControlParser,
  cursorStyleCode,
  paneTarget,
  parsePaneInfo,
  resizeCommand,
  sendKeysCommands,
  sessionName,
  sessionTarget,
  unescapeOutput,
} from "../../server/terminal-host/tmux-protocol.ts";

describe("unescapeOutput（K5・8進戻し）", () => {
  it("\\ooo を1バイトに戻す。バックスラッシュ自身は \\134", () => {
    expect([...unescapeOutput("a\\015\\012b\\134c")]).toEqual([0x61, 0x0d, 0x0a, 0x62, 0x5c, 0x63]);
  });
  it("80 以上の生バイトはそのまま通る（latin1 で読んだ UTF-8）", () => {
    const raw = Buffer.from("日本語😀", "utf8").toString("latin1");
    expect(unescapeOutput(raw).toString("utf8")).toBe("日本語😀");
  });
  it("8進でない並びはそのまま", () => {
    expect(unescapeOutput("\\9ab").toString("latin1")).toBe("\\9ab");
  });
});

describe("名前と target（K5）", () => {
  it("ac-<id>。: と . と空白は拒否", () => {
    expect(sessionName("abc-123_X")).toBe("ac-abc-123_X");
    for (const bad of ["a:b", "a.b", "a b", "", "a\nb"]) expect(() => sessionName(bad)).toThrow();
  });
  it("セッション命令は =名前、pane 命令は =名前:（前方一致を避ける）", () => {
    expect(sessionTarget("ac-a")).toBe("=ac-a");
    expect(paneTarget("ac-a")).toBe("=ac-a:");
    expect(paneTarget("ac-a")).not.toBe(paneTarget("ac-ab"));
  });
  it("全ての呼び出しに -u -L <socket> -f <conf> が付く", () => {
    expect(commonArgs({ tmux: "/x/tmux", socket: "agent-console", conf: "/c/a.conf" })).toEqual(["-u", "-L", "agent-console", "-f", "/c/a.conf"]);
  });
});

describe("send-keys 分割", () => {
  it("1000 バイトずつに分ける。日本語の途中で割れても合計は元と同じ", () => {
    const data = "あ".repeat(1000); // 3000 バイト
    const cmds = sendKeysCommands("ac-a", data);
    expect(cmds).toHaveLength(3);
    const bytes = cmds.flatMap((c) => c.split(" -H ")[1].split(" ").map((h) => parseInt(h, 16)));
    expect(Buffer.from(bytes).toString("utf8")).toBe(data);
    expect(cmds[0].startsWith("send-keys -t =ac-a: -H ")).toBe(true);
    for (const c of cmds) expect(c.split(" -H ")[1].split(" ").length).toBeLessThanOrEqual(1000);
  });
  it("空文字は命令なし", () => {
    expect(sendKeysCommands("ac-a", "")).toEqual([]);
  });
  it("resize は refresh-client -C", () => {
    expect(resizeCommand(100, 30)).toBe("refresh-client -C 100x30");
  });
});

describe("has-session の振り分け（K12）", () => {
  const cases: Array<[number | null, string, string]> = [
    [0, "", "alive"],
    [1, "can't find session: ac-x\n", "gone"],
    [1, "no server running on /private/tmp/tmux-501/agent-console\n", "gone"],
    [1, "no current target\n", "gone"],
    [1, "error connecting to /private/tmp/tmux-501/agent-console (Permission denied)\n", "unreachable"],
    [1, "protocol version mismatch (client 8, server 7)\n", "unreachable"],
    [null, "", "unreachable"],
    [1, "", "unreachable"],
  ];
  it.each(cases)("rc=%s stderr=%j -> %s", (rc, err, expected) => {
    expect(classifyHasSession(rc, err)).toBe(expected);
  });
});

describe("ControlParser", () => {
  const feed = (parser: ControlParser, text: string) => parser.push(Buffer.from(text, "latin1"));

  it("%begin〜%end のブロックと、外の %output・通知を分ける。ブロックの途中で切れた入力も扱える", () => {
    const p = new ControlParser();
    const ev = [
      ...feed(p, "%begin 100 5 0\n%end 100 5 0\n%session-changed $0 ac-x\n%begin 100 6 1\nhello\n%e"),
      ...feed(p, "nd 100 6 1\n%output %0 ab\\015\\012\n%exit\n"),
    ];
    expect(ev.map((e) => e.kind)).toEqual(["block", "notice", "block", "output", "notice"]);
    const b = ev[2];
    if (b.kind !== "block") throw new Error("block expected");
    expect(b.block).toMatchObject({ num: 6, flags: 1, ok: true, lines: ["hello"] });
    const o = ev[3];
    if (o.kind !== "output") throw new Error("output expected");
    expect(o.pane).toBe("%0");
    expect(o.data.toString("latin1")).toBe("ab\r\n");
  });
  it("%error のブロックは ok=false", () => {
    const p = new ControlParser();
    const ev = feed(p, "%begin 1 7 1\nparse error: unknown command: bogus\n%error 1 7 1\n");
    expect(ev).toHaveLength(1);
    const b = ev[0];
    if (b.kind !== "block") throw new Error("block expected");
    expect(b.block.ok).toBe(false);
    expect(b.block.lines).toEqual(["parse error: unknown command: bogus"]);
  });
  it("ブロックの中の %output 風の行や、番号の違う %end は内容として扱う", () => {
    const p = new ControlParser();
    const ev = feed(p, "%begin 1 8 1\n%output %0 x\n%end 1 99 1\n%end 1 8 1\n");
    expect(ev).toHaveLength(1);
    const b = ev[0];
    if (b.kind !== "block") throw new Error("block expected");
    expect(b.block.lines).toEqual(["%output %0 x", "%end 1 99 1"]);
  });
  it("80 以上のバイトを含む %output は、バイトのまま戻る", () => {
    const p = new ControlParser();
    const value = Buffer.from("日本語", "utf8").toString("latin1");
    const ev = p.push(Buffer.concat([Buffer.from("%output %1 ", "latin1"), Buffer.from("日本語", "utf8"), Buffer.from("\n")]));
    const o = ev[0];
    if (o.kind !== "output") throw new Error("output expected");
    expect(o.data.toString("utf8")).toBe("日本語");
    expect(value.length).toBe(9);
  });
});

describe("CommandQueue", () => {
  it("送った順に取り出し、空なら undefined", () => {
    const q = new CommandQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    expect(q.take(1)).toBe(1);
    expect(q.take(2)).toBe(2);
    expect(q.take(3)).toBeUndefined();
  });
});

describe("先入れ（replay）", () => {
  const info = parsePaneInfo("1234 0 5 3 2 1 default 0 4294967295 4294967295 0 [7,25,1004,2004]");
  it("display の値を読む", () => {
    expect(info).toMatchObject({ pid: 1234, alternateOn: false, historySize: 5, cursorX: 3, cursorY: 2, cursorVisible: true, keypad: false, privateModes: [7, 25, 1004, 2004] });
  });
  it("通常画面: 消去 → 履歴＋画面 → モード（25 を除く）→ カーソル形・位置・表示", () => {
    const out = buildReplay({ info: info!, history: ["h1", "h2"], normal: ["row1", "row2"], alt: [] });
    expect(out.startsWith("\x1b[H\x1b[2J\x1b[3J")).toBe(true);
    expect(out).toContain("h1\r\nh2\r\nrow1\r\nrow2");
    expect(out).toContain("\x1b[?7h\x1b[?1004h\x1b[?2004h");
    expect(out).not.toContain("\x1b[?25h\x1b[?1004h");
    expect(out.endsWith("\x1b[0 q\x1b[3;4H\x1b[?25h")).toBe(true);
    expect(out).not.toContain("\x1b[?1049h");
  });
  it("alt 画面: 通常画面を書いた後、保存カーソルへ移って 1049h、alt 画面を書く", () => {
    const alt = parsePaneInfo("1 1 0 0 0 0 block 1 4 9 1 [25,1049,1000]")!;
    const out = buildReplay({ info: alt, history: [], normal: ["normal"], alt: ["alt1", "alt2"] });
    expect(out).toContain("normal\x1b[10;5H\x1b[?1049h\x1b[H\x1b[2Jalt1\r\nalt2");
    expect(out).toContain("\x1b[?1000h\x1b=");
    expect(out.indexOf("\x1b[?1049h")).toBeLessThan(out.indexOf("\x1b[?1000h"));
    expect(out.endsWith("\x1b[1 q\x1b[1;1H\x1b[?25l")).toBe(true);
  });
  it("カーソル形の値", () => {
    expect(cursorStyleCode("block", true)).toBe(1);
    expect(cursorStyleCode("block", false)).toBe(2);
    expect(cursorStyleCode("underline", true)).toBe(3);
    expect(cursorStyleCode("bar", false)).toBe(6);
    expect(cursorStyleCode("default", false)).toBe(0);
  });
});
