// ビルドの最後に、サーバーが import する素の JS（hooks/ac-board.mjs）を dist-server/hooks/ へ写す。
// tsc は .mjs を出力しないが、dist-server/server/boards.js は ../hooks/ac-board.mjs を import するため。
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "dist-server", "hooks");
mkdirSync(dest, { recursive: true });
copyFileSync(path.join(root, "hooks", "ac-board.mjs"), path.join(dest, "ac-board.mjs"));
console.log("copy-board-command: dist-server/hooks/ac-board.mjs");
