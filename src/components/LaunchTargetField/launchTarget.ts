import { useEffect, useState } from "react";
import { fetchResumeTargets } from "../../api";
import type { ResumeTarget, RoleView } from "../../types";

/** 作業用コピーの一覧（GET /api/resume-targets）を、active のときだけ1回取る。null は読み込み中。 */
export function useLaunchTargets(active: boolean): { targets: ResumeTarget[] | null; loadError: boolean } {
  const [state, setState] = useState<{ targets: ResumeTarget[] | null; loadError: boolean }>({ targets: null, loadError: false });
  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetchResumeTargets().then(
      (r) => { if (alive) setState({ targets: r.items, loadError: false }); },
      () => { if (alive) setState({ targets: null, loadError: true }); },
    );
    return () => { alive = false; };
  }, [active]);
  return state;
}

/** 保存できない状態か（作業用コピー型で、一覧が読めていない・0件のとき）。本店型は一覧に関係なく保存できる。 */
export const launchBlocked = (role: RoleView | undefined, targets: ResumeTarget[] | null, loadError: boolean): boolean =>
  role?.needsWorktree === true && (targets === null || loadError || !targets.some((x) => x.kind === "worktree"));

/** 送る cwd・branch。本店型は含めない（サーバーが本店にする）。作業用コピー型は選んだ行の path と branch。 */
export const launchFields = (role: RoleView | undefined, targets: ResumeTarget[] | null, picked: string): { cwd?: string; branch?: string } => {
  if (!role?.needsWorktree) return {};
  const branch = targets?.find((x) => x.path === picked)?.branch;
  return { cwd: picked, ...(branch ? { branch } : {}) };
};
