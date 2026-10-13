// ビルドの最後に、サーバーが import する素の JS（hooks/ac-board.mjs・hooks/ac-statusline.mjs）を dist-server/hooks/ へ写す。
// tsc は .mjs を出力しないが、dist-server/server/boards.js などは ../hooks/*.mjs を import するため。
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "dist-server", "hooks");
mkdirSync(dest, { recursive: true });
for (const name of ["ac-board.mjs", "ac-statusline.mjs"]) {
  copyFileSync(path.join(root, "hooks", name), path.join(dest, name));
  console.log(`copy-board-command: dist-server/hooks/${name}`);
}
