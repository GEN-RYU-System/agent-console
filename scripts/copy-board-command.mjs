// ビルドの最後に、サーバーが import する素の JS（hooks/ac-board.mjs・hooks/ac-reserve.mjs・hooks/ac-routine.mjs・hooks/ac-routine-guard.mjs・hooks/ac-statusline.mjs・hooks/activity-hook.mjs）を dist-server/hooks/ へ写す。
// tsc は .mjs を出力しないが、dist-server/server/boards.js・http.js などは ../hooks/*.mjs を import するため（本番は `node dist-server/server/index.js` で起動する）。
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "dist-server", "hooks");
mkdirSync(dest, { recursive: true });
for (const name of ["ac-board.mjs", "ac-reserve.mjs", "ac-routine.mjs", "ac-routine-guard.mjs", "ac-statusline.mjs", "activity-hook.mjs"]) {
  copyFileSync(path.join(root, "hooks", name), path.join(dest, name));
  console.log(`copy-board-command: dist-server/hooks/${name}`);
}
