import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@sa/components/Button";
import { Modal } from "@sa/components/Modal";
import { updateQuickPrompt } from "../../api";
import type { QuickPrompt } from "../../types";
import { QuickPromptEditor } from "./QuickPromptEditor";
import "./QuickPrompts.css";

interface Props {
  prompts: QuickPrompt[];
  /** 選択中のセッションが送れる状態か（作業中も可。確認待ち・停止中・状態不明は false）。onPick を渡したときは使わない */
  canSend?: boolean;
  /** 押せないときの理由（1行）。登録済みの常に表示の指示があるときだけバーに出す */
  blockedHint?: string;
  /** 端末の上のバー: 押したときに、その指示を選択中の端末の入力欄に入れる（id を渡す） */
  onSend?: (promptId: string) => void;
  /** チャットのバー: 押したときに、本文を渡す（入力欄に入れるだけ。送らないので、送れない状態でも押せる） */
  onPick?: (text: string) => void;
  /** 「常に表示」の切替・追加・編集・削除・並べ替えのあとに一覧を読み直す */
  onChanged: () => void;
}

/**
 * 「よく使う指示」のバー（1 行）。常に表示にした指示だけを並べ、全件の使う・常に表示・並べ替え・登録・編集・削除は左のボタンで開く 1 つの画面で行う。
 * 端末の上では、人が押したときだけ選択中の端末の入力欄に入れる（onSend。Enter は送らない）。チャットでは、押すと本文を入力欄に入れるだけ（onPick）。部品は 1 つ。
 */
export function QuickPromptBar({ prompts, canSend = false, blockedHint, onSend, onPick, onChanged }: Props) {
  const { t } = useTranslation();
  const [listOpen, setListOpen] = useState(false);
  const pinned = prompts.filter((p) => p.pinned);

  const handleTogglePinned = (p: QuickPrompt): Promise<unknown> => updateQuickPrompt(p.id, { pinned: !p.pinned });

  const usable = onPick !== undefined || canSend;
  const use = (p: QuickPrompt): void => {
    if (onPick !== undefined) onPick(p.text);
    else onSend?.(p.id);
  };
  const handleUse = (p: QuickPrompt): void => {
    setListOpen(false);
    use(p);
  };

  return (
    <div className="ac-quick" data-testid="quick-prompt-bar" role="toolbar" aria-label={t("ac.quick.title")}>
      <Button variant="ghost" size="sm" layoutClassName="ac-quick__list-button" onClick={() => setListOpen(true)}>
        {t("ac.quick.title")}
      </Button>
      <div className="ac-quick__buttons">
        {prompts.length === 0 && <span className="ac-quick__empty">{t("ac.quick.empty")}</span>}
        {prompts.length > 0 && pinned.length === 0 && <span className="ac-quick__empty">{t("ac.quick.noPinned")}</span>}
        {pinned.map((p) => (
          <Button key={p.id} variant="outline" size="sm" disabled={!usable} onClick={() => use(p)} title={p.text}>
            {p.label}
          </Button>
        ))}
        {!usable && blockedHint !== undefined && pinned.length > 0 && <span className="ac-quick__empty">{blockedHint}</span>}
      </div>
      <Modal open={listOpen} onClose={() => setListOpen(false)} title={t("ac.quick.title")} size="lg">
        <QuickPromptEditor prompts={prompts} onChanged={onChanged} onTogglePinned={handleTogglePinned} onUse={handleUse} usable={usable} />
      </Modal>
    </div>
  );
}
