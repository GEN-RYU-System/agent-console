import type { ComponentProps } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

/** リンクは別のタブで開く。href が空（urlTransform が危ない URL を空にした）ときは、リンクにせず文字だけ出す */
function ChatLink({ href, children }: ComponentProps<"a">) {
  if (href === undefined || href === "") return <span>{children}</span>;
  // Markdown の本文の中のリンク。本文は Claude の文章で、金型のボタン・リンクの部品では書けないので、生の a 要素を使う（pages の外なので lint の対象外）
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** 画像は読み込まない（外へ取りに行かない）。代わりの文字（alt）だけ出す */
function ChatImage({ alt }: ComponentProps<"img">) {
  return <span>{alt ?? ""}</span>;
}

const COMPONENTS: Components = { a: ChatLink, img: ChatImage };

/**
 * Claude の返事を Markdown として描画する（見出し・箇条書き・太字・コード・表）。
 * HTML は描画しない（skipHtml を明示。rehype-raw は使わない）。URL は react-markdown の既定の変換
 * （http・https・irc・ircs・mailto・xmpp と相対だけを通し、javascript: などは空にする）をそのまま使う。
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="ac-chat__md">
      <Markdown remarkPlugins={REMARK_PLUGINS} skipHtml urlTransform={defaultUrlTransform} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
