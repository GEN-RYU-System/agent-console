#!/usr/bin/env python3
# 写し（agent-console 便2b-3c の参考。段階 P の試しの台本。製品のコードではない。道は公開用に <…> へ伏せた）
# 試しの部屋 room.sb を作る（設計 §4-1 の規則の順 1〜5）。製品のコードではない。
# 使い方: mkroom.py <出力> [kc=0|1] [ci=0|1] [extra=<ファイル>]
import sys, re
B = "<試しの置き場>"  # 公開用に伏せた
H = "<ホーム>"  # 公開用に伏せた
M = "<本店>"  # 公開用に伏せた
W, R, T, D = B + "/W", B + "/R", B + "/T", B + "/D"
CH = D + "/case-home/t1"
OSTMP = "<os.tmpdir() の realpath>"  # 公開用に伏せた
CLAUDE_LINK = H + "/.local/bin/claude"
CLAUDE_REAL = H + "/.local/share/claude/versions/<版>"
PROXY, ACPORT = 18124, 18125

out = sys.argv[1]
opt = dict(a.split("=", 1) for a in sys.argv[2:])
kc = opt.get("kc", "0") == "1"      # Keychains を開けた形（P1d 用）
ci = opt.get("ci", "1") == "1"      # 保護の道を大文字小文字を問わない形で書く
extra = open(opt["extra"]).read() if "extra" in opt else ""

def q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

def reesc(s):
    return re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", s)

def cip(s):
    if not ci:
        return reesc(s)
    o = ""
    for ch in s:
        if ch.isalpha():
            o += "[%s%s]" % (ch.lower(), ch.upper())
        else:
            o += reesc(ch)
    return o

L = []
a = L.append
a("(version 1)")
a('(deny default (with message "ROOM131"))')
a("; ===== 1. 土台 (srt msu.js:753-922 の写し。mach-lookup は名前を完全に書く。AppleEvents・lsopen は無し) =====")
for s in ["(allow process-exec)", "(allow process-fork)", "(allow process-info* (target same-sandbox))", "(allow signal (target same-sandbox))",
          "(allow mach-priv-task-port (target same-sandbox))", "(allow user-preference-read)"]:
    a(s)
mach = ["com.apple.audio.systemsoundserver", "com.apple.distributed_notifications@Uv3", "com.apple.FontObjectsServer", "com.apple.fonts",
        "com.apple.logd", "com.apple.lsd.mapdb", "com.apple.PowerManagement.control", "com.apple.system.logger",
        "com.apple.system.notification_center", "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership",
        "com.apple.bsd.dirhelper", "com.apple.coreservices.launchservicesd", "com.apple.trustd.agent"]
if kc:
    mach += ["com.apple.securityd.xpc", "com.apple.SecurityServer"]
a("(allow mach-lookup")
for m in mach:
    a("  (global-name %s)" % q(m))
a(")")
a("(allow ipc-posix-shm)\n(allow ipc-posix-sem)")
a('(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))')
a("(allow iokit-get-properties)")
a("(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))")
# sysctl は srt の写し（隣の srt の出力から丸ごと）
sysctl = open(B + "/tools/sysctl-block.txt").read().rstrip("\n")
a(sysctl)
a("(allow sysctl-write (sysctl-name \"kern.tcsm_enable\"))")
a("(allow distributed-notification-post)")
for d in ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper", "/dev/tty"]:
    a("(allow file-ioctl (literal %s))" % q(d))
a('(allow file-ioctl file-read-data file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))')

a("; ===== 2. 読み取り =====")
a("(allow file-read*)")
deny_read = [H, "<報告の置き場の親>", "/private/tmp/claude-<uid>", OSTMP, M]
a("(deny file-read*")
for p in deny_read:
    a("  (subpath %s)" % q(p))
a(")")
reopen_sub = [W, R, T, CH, D + "/case-gh/t1"]
reopen_lit = [H + "/.gitconfig", H + "/.config/git/config", H + "/.config/git/ignore", H + "/.config/git/attributes", CLAUDE_LINK, CLAUDE_REAL,
              D + "/cases/t1/settings.json", D + "/cases/t1/case.json",
              D + "/hooks/activity-hook.mjs", D + "/hooks/activity-send.mjs", D + "/hooks/ac-routine-guard.mjs", D + "/hooks/server-kill-guard.mjs",
              D + "/ops-case/case-guard.mjs"]
if kc:
    reopen_sub.append(H + "/Library/Keychains")
a("(allow file-read*")
for p in reopen_sub:
    a("  (subpath %s)" % q(p))
for p in reopen_lit:
    a("  (literal %s)" % q(p))
a("  (literal (param \"TTY\"))")
a(")")
# 開け直しの塊のあとは拒否だけ: 開け直しの道の中にある拒否は無い（D/cases/<他の id> は開けていない）
a("(deny file-read* (literal %s))" % q(D + "/cases/t1/room.sb"))
a("(allow file-read-metadata (vnode-type DIRECTORY))")
mv_roots = deny_read
a("(deny file-write-unlink file-write-create")
for p in mv_roots:
    a("  (subpath %s)" % q(p))
a(")")
a("(allow file-write-unlink file-write-create")
for p in [W, R, T, CH]:
    a("  (subpath %s)" % q(p))
a(")")

a("; ===== 3. 書き込み =====")
a("(allow file-write*")
for p in [W, R, T, CH]:
    a("  (subpath %s)" % q(p))
a('  (literal "/dev/null")\n  (literal (param "TTY"))\n)')
a('(allow file-ioctl (literal (param "TTY")))')
danger_files = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"]
danger_dirs = [".vscode", ".idea", ".claude/commands", ".claude/agents", ".claude/skills", ".claude/hooks", ".git/hooks"]
danger_lit_files = [".claude/settings.json", ".claude/settings.local.json", ".git/config"]
bare = ["HEAD", "objects", "refs", "config"]
regs = []
for X in [W, R, CH]:
    for f in danger_files + danger_lit_files:
        regs.append(r'^%s/(.+/)?%s$' % (reesc(X), cip(f)))
    for d in danger_dirs:
        regs.append(r'^%s/(.+/)?%s(/.*)?$' % (reesc(X), cip(d)))
    for b in bare:
        regs.append(r'^%s/%s(/.*)?$' % (reesc(X), cip(b)))
a("(deny file-write*")
for r in regs:
    a('  (regex #"%s")' % r)
# CASE_DENY_WRITE: ホーム・件の設定・活動の記録・case-home の本体の設定
for p in [H + "/.claude", H + "/.claude.json", H + "/.zshrc", D + "/cases", D + "/activity", D + "/hooks", D + "/ops-case",
          ]:
    a("  (subpath %s)" % q(p))
for x in ["settings.json","agents","hooks","commands","skills","CLAUDE.md"]:
    a('  (regex #"^%s/%s(/.*)?$")' % (reesc(CH), reesc(x)))
    a('  (require-all (vnode-type REGULAR-FILE) (literal %s))' % q(CH + "/" + x)) if False else None
a(")")

a("; ===== 4. 移動の塞ぎ =====")
a("(deny file-write-unlink file-write-create")
for r in regs:
    a('  (regex #"%s")' % r)
for x in ["settings.json","agents","hooks","commands","skills","CLAUDE.md"]:
    a('  (regex #"^%s/%s(/.*)?$")' % (reesc(CH), reesc(x)))
for X in [W, R, CH]:
    a("  (literal %s)" % q(X))
    a("  (literal %s)" % q(X + "/.claude"))
    a("  (literal %s)" % q(X + "/.git"))
    a('  (regex #"^%s/(.+/)?%s$")' % (reesc(X), cip(".git")))
    a('  (regex #"^%s/(.+/)?%s$")' % (reesc(X), cip(".claude")))
a(")")

a("; ===== 5. 通信 =====")
a('(allow network-outbound (remote ip "localhost:%d"))' % PROXY)
a('(allow network-outbound (remote ip "localhost:%d"))' % ACPORT)
if extra:
    a("; ===== 追加（P2 の記録から足した物。理由は P2-additions.txt） =====")
    a(extra)
open(out, "w").write("\n".join(L) + "\n")
print("wrote", out, len(L), "lines")
