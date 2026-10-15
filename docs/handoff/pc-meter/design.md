# 設計書: Mac の CPU・RAM・Disk 表示（agent-console v0.38.0）第1.0版
作成: Claude Opus（設計）2026-10-15。状態: 設計案作成済み（審査前）。

## 1. 目的（PO の言葉）
- 原文: 「右端にPCのCPU,RAM,Disk使用率を見える化して欲しい。Claude ログイン…と週と5時間のプログレスバーと水平に配置してプログレスバーで表示」「セッションごとのCPU,RAM,Disk使用率も…会話の満杯度の右側に%で表示」
- PO 決定（10/15 y）: Disk は Mac 全体の容量の使用率だけを下の帯のバーで出す。セッション行は「会話の満杯度・CPU %・RAM %」。プロセス別の Disk は出さない。
- 前提: 下の帯の組み直し（release/footer-layout、v0.37.0。v0.36.0 は別作業で使用済み＝origin/main package.json "0.36.0"・タグ v0.36.0）がマージされた後の main から作る。

## 2. 変更前 → 変更後（利用者に見える変化）
| 場所 | 前 | 後 |
|---|---|---|
| 下の帯 右端 | 🌙・展開元・版・コミット | 上段に「この Mac」CPU・RAM・Disk の3本バー（Claude 欄と同じ高さ帯）、その下に 🌙・展開元・版・コミット（小さく薄く、v0.37.0 のまま） |
| 各セッションの画面下の1行 | `会話の満杯度 42%` | `会話の満杯度 42% · CPU 3% · RAM 4%` |
| メモリの詳細画面（MemoryPanel） | 変更なし（ボタンは v0.37.0 で非表示、部品と API は残置） | 変更なし |

## 3. 事実（根拠）
- 既存計測: server/memory.ts MemoryCollector（ps 表＋sysctl＋memory_pressure、5秒キャッシュ、:81-127）。セッション RAM は pty pid の子孫 RSS 合計（:58-64、process-tree.ts:31-55）。/api/memory 応答型 src/types.ts:137。（/tmp/CC報告ファイル/pc-meter/report.md §5）
- readProcessTable は sessions.ts:525（終了時の子孫確認）でも使う。（report.md §5）
- Claude の session_id: Session.claudeSessionId（server/sessions.ts:71）。hub.ts:570-573 が claude agents --json の pid を pty 子孫と照合して入れる。statusline 入力の session_id と一致するかは未確認 → K5 で実測。（r2/report2.md §2）
- 定期処理の型: hub.ts:145 `startPolling(fn, config.agentsPollMs, onError)`（server/poll.ts）。
- ps %cpu: man ps「a decaying average over up to a minute」。実験で停止10秒後 0.0（r2/man_ps.txt, cpu_exp.txt）。→ セッション CPU は「直近の平均（なめらかにした値）」。
- Mac 全体 CPU: Node os.cpus() の times（ミリ秒累計、公式 https://nodejs.org/docs/latest-v24.x/api/os.html）の2時点差。top との差 0.5〜7.9pt（r2/cpu_cmp.txt）。
- Disk: fs.promises.statfs（v18.15.0 追加、公式 doc/api/fs.md:1724・:7623-7667、r3/statfs_doc.txt）。engines node >=24、実機 v24.12.0。
  - 実測（r3/statfs_vs_df.txt）: blocks 239362496KB、bavail 14995096KB → (blocks−bavail)/blocks = 93.74%。df の Capacity 93% は「このボリュームの使用量／(使用量＋空き)」で APFS の他ボリュームを含まない。
  - 採用: (blocks − bavail) / blocks。理由: 「あと何GB空いているか」と一致し、他ボリューム（システム等）が使う分も含めた満杯度になる。
- Context7 は月間上限で利用不可（resolve-library-id が "Monthly quota exceeded"）。代わりに Node 公式文書を直接確認した。
- バー部品: SA の ProgressBar（value/variant/label、100以上で完了表示 :22,:42-56）。UsageMeter は100%以上でバーを出さず Badge（UsageMeter.tsx:42-57）。usageLevel 80/95/100（usageLogic.ts:14-20）。（r2/report2.md §5）
- statusline: ~/.claude/statusline.sh（リポジトリ外、38行）が満杯度1行を表示。ac-statusline.mjs は裏で usage.json を書くだけ（出力 /dev/null）。refreshInterval 未設定（~/.claude/settings.json:379-382）。

## 4. 設計
### 4.1 計測（SSOT: 計測はサーバーの MemoryCollector 1か所）
- process-tree.ts: readProcessTable を `ps -axo pid=,ppid=,rss=,%cpu=` に変更。PsRow に `cpu: number` を追加（既存呼び出し sessions.ts:525 は pid/ppid しか使わないので影響なし。実装時に全呼び出し元を grep で確認）。sumCpu(pids, rows) を追加。
- memory.ts:
  - SystemMemory（名前は維持）に `cpuPercent: number | null`、`diskUsedPercent: number | null`、`diskTotalGb: number | null` を追加。
  - CPU: collector が前回の os.cpus() 合計 times を保持し、今回との差で `busy/total×100`（busy = user+nice+sys+irq）。前回が無い初回は null。差分を取るのは定期計測（4.1 末尾）の時だけにする。/api/memory の要求で読み直す時（memory.ts:121 の強制読み直しを含む）は直近の cpuPercent をそのまま使う（窓が極端に短くなって値が跳ねるのを防ぐ）。
  - Disk: `statfs("/System/Volumes/Data")` → `(blocks−bavail)/blocks×100`。失敗時 null。
  - SessionMemory に `cpuPercent`（子孫 %cpu 合計 ÷ os.availableParallelism()、Mac 全体を100とした割合）と `ramPercent`（rssMb ÷ totalMb ×100、totalMb 不明なら null）を追加。
  - 小数1桁に丸め。既存フィールドは変えない（MemoryPanel・既存試験はそのまま通る）。
- 定期計測: hub か index で `startPolling(() => collector.collect(liveSessions) → writeSessionMetrics, config.metricsPollMs)`。既定 5000ms（config に追加、既存 agentsPollMs と同じ型）。CPU の差分の窓はこの5秒。
- /api/memory はキャッシュ済みの結果を返す（新 API は作らない）。

### 4.2 セッション行への受け渡し
- サーバーが dataDir/session-metrics.json を書く: `{ updatedAt, sessions: { "<claudeSessionId>": { cpuPercent, ramPercent } } }`。書き方は usage.json と同じ（一時ファイル→0600→rename、ac-statusline.mjs:62-82 の型）。claudeSessionId が無いセッションは載せない。
  - これは計測の写しであり、計測は1か所（データの分散ではない）。読み手は statusline だけ。
- hooks/ac-statusline.mjs に `--metrics` モードを追加: stdin の session_id で session-metrics.json を引き、updatedAt が30秒以内なら ` · CPU N% · RAM M%` を出力、それ以外は空。
- ~/.claude/statusline.sh（リポジトリ外）: 最後の printf に上の出力を付け足す（2行の変更。変更前の写しを ~/CC報告ファイル-keep/pc-meter/statusline.sh.bak に保存）。
- ~/.claude/settings.json の statusLine に `"refreshInterval": 10` を追加（返事が無い間も10秒ごとに更新。公式仕様 refreshInterval 最小1秒）。変更前の写しを保存。

### 4.3 下の帯の表示
- 新部品 src/components/MacMeter/（MacMeter.tsx・.css・.test.tsx）。行は CPU / RAM / Disk。各行: ラベル・ProgressBar・`N%`。100%以上は UsageMeter と同じく Badge（usageLevel を流用）。null のときは「計測中」。
- データは /api/memory（既存 fetchMemory、src/api.ts:160）を MEMORY_REFRESH_MS（10000ms、MemoryPanel.tsx:10）で取得。新しい取得関数は作らない。
- 配置: footer の右端の列に、上から MacMeter → meta（🌙・展開元・版・コミット）。幅は v0.37.0 の `--ac-provider-w`（320px）を流用。新しい px 直値は書かない（check-design-governance）。
- i18n: ac.macMeter.title / cpu / ram / disk / percent / measuring / error を ja・en 同時に追加。
- 「Codex・Grok 用の空き」は中央に残す（v0.37.0 と同じ）。

## 5. 対象外
- プロセス別 Disk（読み書き量）。MemoryPanel の画面変更。Windows/Linux 対応。過去の推移グラフ。

## 6. 代替案と選択理由
- statusline から HTTP で /api/memory を読む案 → 認証トークンが要る・遅い。不採用。
- statusline 自身が ps で計る案 → 計測が2か所になる（SSOT違反）。不採用。
- 新しい /api/system → 計測関数が分かれる。/api/memory を広げる方が1か所で済む。
- Disk を df の Capacity（93%）にする案 → APFS の他ボリューム分を含まず「空き容量」の感覚とずれる。不採用（差は 0.7pt 程度、実測値は §3）。

## 7. リスクと対処
| リスク | 対処 |
|---|---|
| 5秒ごとの ps・memory_pressure の負荷 | 実測の所要（report.md §4: 0.00〜0.18秒）。K9 で計測の所要を記録、中央値 0.3秒超なら止める |
| statusline の session_id と claudeSessionId が一致しない | K5 で実値を突き合わせ。不一致なら CPU/RAM を出さず止めて PO へ |
| 下の帯の高さが 200px を超える | K6 で実測。超えたら止める |
| セッション CPU（なめらかな値）と Mac CPU（5秒差分）の時間幅の違い | 説明文に明記（ツールチップは作らない）。数値の比較は K4 の許容幅で判定 |
| refreshInterval でセッション数×6回/分の statusline 実行 | 1回の所要を K9 で記録 |

## 8. 受入条件
| 基準 | 検証方法 |
|---|---|
| K1 下の帯の右端に CPU・RAM・Disk の3本バーがあり、Claude 欄の上端との差が 4px 以内 | Playwright で getBoundingClientRect、1400・1024 幅 |
| K2 Disk% が (blocks−bavail)/blocks と ±0.5 以内 | 同時刻に node で statfs を取り比較 |
| K3 RAM% が /api/memory system.usedPercent と一致し、memory_pressure の 100−free と ±1 | curl（認証は試験環境）と memory_pressure の生出力 |
| K4 CPU% が 0〜100 の範囲で、同時刻の top -l 2 の 100−idle と ±15 以内（3回） | 生出力を保存 |
| K5 (a) 単体試験: session_id が一致し30秒以内なら ` · CPU a% · RAM b%`、古い・無い・壊れたファイルなら空。(b) 導入後: 実在の claudeSessionId（open-sessions.json の値）を session_id に入れた stdin で statusline.sh を実行し、出力の a・b が同時刻の session-metrics.json と一致。(c) PO 目視: 2つのセッションの画面下に3つの値が出る | 試験の生出力、statusline.sh の出力と json の cat（担当は agent-console の tmux に触らない） |
| K6 下の帯の高さ ≤ 200px、バーのはみ出しなし、空き幅 ≥ 600px（1400幅） | Playwright 実測＋スクショ（ダーク・ライト） |
| K7 npm test・e2e・typecheck・lint がすべて通る。px 直値なし | 生出力 |
| K8 ja.json/en.json に同じキー | 試験 |
| K9 定期計測1回の所要の中央値 ≤ 0.3秒（20回） | サーバーのログ |
| K10 既存の MemoryPanel 試験が無変更で通る | npm test |

## 9. 戻し方
- アプリ: `ac-update.sh v0.37.0`。statusline.sh・settings.json は .bak から戻す。session-metrics.json は残っても読み手が無いだけ（害なし）。

## 10. 維持する仕組み
- 計測は MemoryCollector 1か所、受け渡しは session-metrics.json 1つ。単体試験で CPU 差分・Disk 計算・ramPercent・30秒の鮮度判定を固定値で検証する。

## 11. 外部事例
- 不要。理由: OS の計測値の取り方は公式文書（Node os/fs、man ps）と実測で根拠が揃い、事例の数値が設計判断を左右しないため。

## 12. 未解決（実装前に確認）
- U1 statusline 実行時の環境に CLAUDE_CODE_SESSION_ID があるか（stdin の session_id で足りるため必須ではない）。
- U2 PR 作成時点の v0.37.0 マージ後 main の footer 構造（ConsolePage.tsx の行番号）を実装前に再取得する。

## 13. 承認記録
- 2026-10-15 PO 原文「y」（問い: v0.37.0 導入後、v0.38.0 として実装・審査・マージ・導入まで進め最後に目視を依頼してよいか）。→ 実装承認。
