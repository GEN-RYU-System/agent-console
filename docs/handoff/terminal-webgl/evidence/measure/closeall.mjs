// 試験サーバーのセッションを全部閉じる（上限 16 に当たらないように）
import { api, PORTS } from "./lib.mjs";
for (const p of Object.values(PORTS)) {
  const s = (await api(p, "GET", "/api/state")).json.sessions;
  for (const x of s) await api(p, "POST", `/api/sessions/${x.id}/close`);
  console.log(p, "closed", s.length);
}
