== ac1
16:26  up 10 days,  2:28, 2 users, load averages: 18.68 13.39 12.41
16:27  up 10 days,  2:29, 2 users, load averages: 16.05 14.45 12.95
claude B-1notch: wheel=7 send=6 recv=58 render=3
claude B-1notch: wheel=7 send=6 recv=83 render=4
claude B-1notch: wheel=7 send=6 recv=28 render=2
claude B-1notch: wheel=7 send=6 recv=67 render=2
claude B-1notch: wheel=7 send=6 recv=42 render=3
claude B-1notch: wheel=7 send=6 recv=87 render=3
claude B-1notch: wheel=7 send=6 recv=50 render=4
claude B-1notch: wheel=7 send=6 recv=56 render=3
claude C-30notch: wheel=205 send=176 recv=1070 render=42
claude C-30notch: wheel=212 send=182 recv=967 render=65
claude C-30notch: wheel=212 send=182 recv=857 render=66
claude C-30notch: wheel=212 send=182 recv=778 render=59
| 組 | 回 | 送信→サーバー受け(W) p50/p90 | W→tmuxの最初の返り p50/p90 | tmuxの返りの33ms超の間 / 最大 | サーバー送り(O)→ブラウザ受け p50/p90/max | ブラウザ受けの33ms超の間 / 最大 | 描画の33ms超の間 / 最大 | 通数 O/受け |
|---|---|---|---|---|---|---|---|---|
| A-oneline | 12 | 1.2/2.7 | 0.6/3.4 | 5 / 414.9 | 1.0/2.4/3.3 | 3 / 414.8 | 4 / 416.6 | 20/20 |
| B-1notch | 8 | 0.4/2.0 | 0.4/4.9 | 6 / 77.5 | 1.0/6.5/8.5 | 5 / 71.9 | 4 / 98.1 | 471/471 |
| C-30notch | 4 | 0.1/1.7 | 0.3/0.8 | 4 / 214.8 | 0.3/1.7/41.3 | 12 / 253.9 | 56 / 284.5 | 3672/3672 |
run: O=1070 bytes=177189 lastWheel=1500 lastO=1732 lastR=1732 lastD=1734
   O@1462+254 R@572+121 R@1462+254 D@201+220 D@421+164 D@585+116 D@1450+285
run: O=967 bytes=247208 lastWheel=1500 lastO=1379 lastR=1379 lastD=1383
   
run: O=857 bytes=256947 lastWheel=1500 lastO=1512 lastR=1513 lastD=1755
   D@1501+254
run: O=778 bytes=242043 lastWheel=1499 lastO=1510 lastR=1511 lastD=1517
   
== direct1
16:27  up 10 days,  2:29, 2 users, load averages: 16.05 14.45 12.95
16:28  up 10 days,  2:30, 2 users, load averages: 13.25 13.91 12.79
C-30notch 1 chunks 426
C-30notch -1 chunks 422
C-30notch 1 chunks 430
| 組 | 回 | 出力の塊 中央 | 間 p50/p90 ms | 33ms超の間 合計 | 100ms超の間 合計 | 最大 ms |
|---|---|---|---|---|---|---|
| B-1notch | 8 | 4 | 0.1/17.9 | 0 | 0 | 22 |
| C-30notch | 4 | 426 | 0.1/11.0 | 4 | 0 | 64 |
B-1notch 1 bytes 3640 
B-1notch 2 bytes 2795 
B-1notch 3 bytes 2611 
B-1notch 4 bytes 0 
B-1notch 5 bytes 5042 
B-1notch 6 bytes 2795 
B-1notch 7 bytes 0 
B-1notch 8 bytes 3692 
C-30notch 1 bytes 135355 
C-30notch 2 bytes 259706 
C-30notch 3 bytes 256220 
C-30notch 4 bytes 259913 
== ac2
16:28  up 10 days,  2:30, 2 users, load averages: 13.25 13.91 12.79
16:29  up 10 days,  2:31, 2 users, load averages: 15.17 14.02 12.91
claude B-1notch: wheel=7 send=6 recv=83 render=3
claude B-1notch: wheel=7 send=6 recv=37 render=3
claude B-1notch: wheel=7 send=6 recv=49 render=3
claude B-1notch: wheel=7 send=6 recv=34 render=3
claude B-1notch: wheel=7 send=6 recv=29 render=3
claude B-1notch: wheel=7 send=6 recv=58 render=3
claude B-1notch: wheel=7 send=6 recv=44 render=3
claude B-1notch: wheel=7 send=6 recv=90 render=3
claude C-30notch: wheel=210 send=180 recv=469 render=14
claude C-30notch: wheel=212 send=182 recv=1258 render=62
claude C-30notch: wheel=206 send=176 recv=942 render=42
claude C-30notch: wheel=214 send=184 recv=894 render=58
| 組 | 回 | 送信→サーバー受け(W) p50/p90 | W→tmuxの最初の返り p50/p90 | tmuxの返りの33ms超の間 / 最大 | サーバー送り(O)→ブラウザ受け p50/p90/max | ブラウザ受けの33ms超の間 / 最大 | 描画の33ms超の間 / 最大 | 通数 O/受け |
|---|---|---|---|---|---|---|---|---|
| A-oneline | 12 | 0.8/4.4 | 0.7/1.7 | 4 / 244.8 | 1.2/3.2/7.1 | 3 / 244.3 | 4 / 275.8 | 22/22 |
| B-1notch | 8 | 0.3/2.0 | 0.6/2.1 | 0 / 28.7 | 1.2/4.4/6.8 | 0 / 26.9 | 2 / 36.7 | 424/424 |
| C-30notch | 4 | 0.0/0.9 | 0.4/1.0 | 0 / 31.9 | 0.6/2.5/43.3 | 13 / 521.8 | 54 / 622.0 | 3563/3563 |
run: O=469 bytes=54083 lastWheel=1567 lastO=1109 lastR=1110 lastD=1212
   O@576+522 R@577+522 D@302+132 D@590+622
run: O=1258 bytes=244966 lastWheel=1499 lastO=1463 lastR=1463 lastD=1466
   
run: O=942 bytes=178812 lastWheel=1500 lastO=1519 lastR=1520 lastD=1534
   O@729+240 R@729+241 D@667+350
run: O=894 bytes=231713 lastWheel=1518 lastO=1242 lastR=1244 lastD=1251
   
== direct2
16:29  up 10 days,  2:31, 2 users, load averages: 15.17 14.02 12.91
16:29  up 10 days,  2:31, 2 users, load averages: 15.58 14.14 12.97
C-30notch 1 chunks 414
C-30notch -1 chunks 403
C-30notch 1 chunks 399
| 組 | 回 | 出力の塊 中央 | 間 p50/p90 ms | 33ms超の間 合計 | 100ms超の間 合計 | 最大 ms |
|---|---|---|---|---|---|---|
| B-1notch | 8 | 0 | NaN/NaN | 0 | 0 | -Infinity |
| C-30notch | 4 | 403 | 0.1/11.2 | 12 | 4 | 340 |
B-1notch 1 bytes 0 
B-1notch 2 bytes 0 
B-1notch 3 bytes 0 
B-1notch 4 bytes 0 
B-1notch 5 bytes 0 
B-1notch 6 bytes 0 
B-1notch 7 bytes 0 
B-1notch 8 bytes 0 
C-30notch 1 bytes 18052 @43+115 @159+290 @517+107 @742+340
C-30notch 2 bytes 250546 
C-30notch 3 bytes 243764 
C-30notch 4 bytes 243578 
