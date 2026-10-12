import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import type { DiffComment, DiffCommentInput, DiffLine } from "../../types";
import { CommentForm } from "./CommentForm";
import { commentMatchesLine, isStale, lineNumberOf, orphanComments, sideOfLine } from "./diffUtils";

interface Props {
  path: string;
  lines: DiffLine[];
  /** このファイルのコメント */
  comments: DiffComment[];
  /** 行を出せないときの説明（未追加・バイナリ・大きすぎる） */
  note?: string;
  onSave: (input: DiffCommentInput, editingId: string | null) => Promise<void>;
  /** 失敗の案内は呼び出し側が出す */
  onDelete: (id: string) => Promise<void>;
}

/** 開いている入力欄: 新しいコメント（lineIndex の行の下、-1 はファイル全体）か、既存コメントの編集。 */
type Editor = { kind: "new"; lineIndex: number } | { kind: "edit"; id: string };

const NO_LINE = -1;

function CommentBox({ comment, stale, editor, onEdit, onDelete, onSave, onClose }: {
  comment: DiffComment;
  stale: boolean;
  editor: Editor | null;
  onEdit: () => void;
  onDelete: () => void;
  onSave: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (editor?.kind === "edit" && editor.id === comment.id) return <CommentForm initialBody={comment.body} onSubmit={onSave} onCancel={onClose} />;
  const where = comment.side === "file" ? t("ac.diff.sideFile") : t(comment.side === "new" ? "ac.diff.sideNew" : "ac.diff.sideOld", { line: comment.line });
  return (
    <div className="ac-diff__comment" data-testid="diff-comment">
      <div className="ac-diff__comment-meta">
        <span className="ac-diff__where">{where}</span>
        {comment.sentAt !== undefined && (
          <Badge variant="success" size="sm">
            {t("ac.diff.sent")}
          </Badge>
        )}
        {stale && (
          <Badge variant="warning" size="sm">
            {t("ac.diff.stale")}
          </Badge>
        )}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t("ac.diff.commentEdit")}
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete}>
          {t("ac.diff.commentDelete")}
        </Button>
      </div>
      <p className="ac-diff__comment-body">{comment.body}</p>
    </div>
  );
}

/** 1 ファイルの変更を行ごとに出し、行を押すとその下にコメント欄を開く。追加行・削除行の色は SA のトークン。 */
export function DiffView({ path, lines, comments, note, onSave, onDelete }: Props) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<Editor | null>(null);
  const close = (): void => setEditor(null);

  const saveNew = (input: Omit<DiffCommentInput, "path" | "body">) => async (body: string): Promise<void> => {
    await onSave({ path, ...input, body }, null);
    close();
  };
  const saveEdit = (comment: DiffComment) => async (body: string): Promise<void> => {
    await onSave({ path, side: comment.side, body, ...(comment.line !== undefined ? { line: comment.line } : {}), ...(comment.lineText !== undefined ? { lineText: comment.lineText } : {}) }, comment.id);
    close();
  };
  const remove = (id: string): void => void onDelete(id);

  const boxFor = (comment: DiffComment, stale: boolean) => (
    <CommentBox
      key={comment.id}
      comment={comment}
      stale={stale}
      editor={editor}
      onEdit={() => setEditor({ kind: "edit", id: comment.id })}
      onDelete={() => remove(comment.id)}
      onSave={saveEdit(comment)}
      onClose={close}
    />
  );
  const fileComments = comments.filter((c) => c.side === "file");
  const orphans = orphanComments(comments, lines);

  return (
    <div className="ac-diff__view" data-testid="diff-view">
      <div className="ac-diff__fileHead">
        <span className="ac-diff__path">{path}</span>
        <Button size="sm" variant="outline" onClick={() => setEditor({ kind: "new", lineIndex: NO_LINE })}>
          {t("ac.diff.fileComment")}
        </Button>
      </div>
      {editor?.kind === "new" && editor.lineIndex === NO_LINE && <CommentForm onSubmit={saveNew({ side: "file" })} onCancel={close} />}
      {note !== undefined && <p className="ac-diff__note">{note}</p>}
      {fileComments.map((c) => boxFor(c, false))}
      <div className="ac-diff__lines">
        {lines.map((line, index) => {
          if (line.kind === "hunk") {
            return (
              <div key={index} className="ac-diff__hunk">
                {line.text}
              </div>
            );
          }
          const attached = comments.filter((c) => commentMatchesLine(c, line));
          const side = sideOfLine(line);
          return (
            <div key={index}>
              <div className={`ac-diff__line ac-diff__line--${line.kind}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  layoutClassName="ac-diff__line-btn"
                  data-testid={`diff-line-${line.kind}`}
                  onClick={() => side !== null && setEditor({ kind: "new", lineIndex: index })}
                >
                  <span className="ac-diff__no">{line.oldLine ?? ""}</span>
                  <span className="ac-diff__no">{line.newLine ?? ""}</span>
                  <span className="ac-diff__text">{line.text}</span>
                  {attached.length > 0 && <MessageSquare className="ac-diff__mark" aria-hidden="true" />}
                </Button>
              </div>
              {attached.map((c) => boxFor(c, isStale(c, line)))}
              {editor?.kind === "new" && editor.lineIndex === index && side !== null && (
                <CommentForm onSubmit={saveNew({ side, line: lineNumberOf(line, side), lineText: line.text })} onCancel={close} />
              )}
            </div>
          );
        })}
      </div>
      {orphans.length > 0 && (
        <div className="ac-diff__orphans">
          <p className="ac-diff__orphan-title">{t("ac.diff.orphanTitle")}</p>
          {orphans.map((c) => boxFor(c, true))}
        </div>
      )}
    </div>
  );
}
