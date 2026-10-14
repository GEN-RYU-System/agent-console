import type { ComponentProps } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./Markdown.css";

const REMARK_PLUGINS = [remarkGfm];

/** chat: 今のチャットの挙動（defaultUrlTransform が通すものは a）。file: http・https だけ a、それ以外は文字だけ */
export type LinkPolicy = "chat" | "file";

const WEB_URL = /^https?:\/\//i;

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

/** ファイルの表示: http・https のリンクだけを a にする（相対・mailto などは文字だけ） */
function FileLink(props: ComponentProps<"a">) {
  if (props.href === undefined || !WEB_URL.test(props.href)) return <span>{props.children}</span>;
  return <ChatLink {...props} />;
}

/** 画像は読み込まない（外へ取りに行かない）。代わりの文字（alt）だけ出す */
function ChatImage({ alt }: ComponentProps<"img">) {
  return <span>{alt ?? ""}</span>;
}

const COMPONENTS: Record<LinkPolicy, Components> = {
  chat: { a: ChatLink, img: ChatImage },
  file: { a: FileLink, img: ChatImage },
};

/**
 * Markdown を描画する（見出し・箇条書き・太字・コード・表）。チャットの返事とファイルの表示で共通。
 * HTML は描画しない（skipHtml を明示。rehype-raw は使わない）。URL は react-markdown の既定の変換
 * （http・https・irc・ircs・mailto・xmpp と相対だけを通し、javascript: などは空にする）をそのまま使う。
 */
export function MarkdownView({ text, linkPolicy = "chat" }: { text: string; linkPolicy?: LinkPolicy }) {
  return (
    <div className="ac-md">
      <Markdown remarkPlugins={REMARK_PLUGINS} skipHtml urlTransform={defaultUrlTransform} components={COMPONENTS[linkPolicy]}>
        {text}
      </Markdown>
    </div>
  );
}
