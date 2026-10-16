import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@sa/components/Badge";
import { Button } from "@sa/components/Button";
import { Callout } from "@sa/components/Callout";
import { EmptyState } from "@sa/components/EmptyState";
import { TextField } from "@sa/components/TextField";
import { fetchFileContent, fetchFiles } from "../../api";
import type { FileContentResponse, FilesResponse } from "../../types";
import { MarkdownView } from "../Markdown/MarkdownView";
import "./FilesPane.css";

type ListState = { kind: "loading" } | { kind: "error" } | { kind: "data"; value: FilesResponse };
type ContentState = { kind: "loading" } | { kind: "error" } | { kind: "data"; value: FileContentResponse };
type Reason = Exclude<FileContentResponse["status"], "ok">;

const REASON_KEYS: Record<Reason, string> = {
  noSession: "ac.files.reason.noSession",
  notListed: "ac.files.reason.notListed",
  missing: "ac.files.reason.missing",
  notRegular: "ac.files.reason.notRegular",
  unreadable: "ac.files.reason.unreadable",
  tooLarge: "ac.files.reason.tooLarge",
  binary: "ac.files.reason.binary",
};

/** 絞り込み用の正規化（全角/半角・大小文字を区別しない） */
const norm = (s: string): string => s.normalize("NFKC").toLowerCase();

const timeOf = (ms: number): string => new Date(ms).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

interface Props {
  sessionId: string;
  /** 「ファイル」タブが開いているか（閉じている間は取得しない） */
  active: boolean;
  /** 記録の版。進んだら（開いている間は）一覧を取り直す */
  rev: number;
  /** 端末のリンクから「このパスを開いて」と頼む口。seq が進むたびに 1 回開く（sessionId が違う依頼は無視） */
  openRequest?: { sessionId: string; path: string; seq: number } | null;
  /** 「端末に戻る」ボタンと、ファイルタブ表示中の Esc で呼ぶ */
  onBackToTerminal?: () => void;
}

/**
 * 「ファイル」タブ。選んだセッションが Write・Edit などで書いたファイル（hook の記録から作る）を一覧にし、選んだものの中身を出す。
 * .md は整えた表示（MarkdownView、http・https 以外のリンクは文字だけ）、それ以外は等幅の文字。読むだけ。
 */
export function FilesPane({ sessionId, active, rev, openRequest, onBackToTerminal }: Props) {
  const { t } = useTranslation();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  // セッションが替わったら選択を外す
  useEffect(() => {
    setList({ kind: "loading" });
    setSelected(null);
    setContent(null);
    setQuery("");
  }, [sessionId]);

  // ファイルタブが表示になった時（切替・端末のリンクから）、焦点がタブの中に無ければ外枠へ移す（端末は hidden で焦点を失うため。Esc を外枠で受ける）
  useEffect(() => {
    const root = rootRef.current;
    if (active && root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [active, openRequest?.seq]);

  const loadList = useCallback(async (): Promise<void> => {
    const id = sessionId;
    try {
      const value = await fetchFiles(id);
      if (sessionRef.current === id) setList({ kind: "data", value });
    } catch {
      if (sessionRef.current === id) setList({ kind: "error" });
    }
  }, [sessionId]);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      const id = sessionId;
      setSelected(path);
      setContent({ kind: "loading" });
      try {
        const value = await fetchFileContent(id, path);
        if (sessionRef.current === id) setContent({ kind: "data", value });
      } catch {
        if (sessionRef.current === id) setContent({ kind: "error" });
      }
    },
    [sessionId],
  );

  // 開いたとき・記録の版が進んだとき（K1: タブを開いたままでも新しいファイルが出る）
  useEffect(() => {
    if (active) void loadList();
  }, [active, rev, loadList]);

  // openRequest の seq が進んだら、そのパスを開く（sessionId が違う依頼は無視）。選択を外す上の effect より後に置く
  useEffect(() => {
    if (openRequest && openRequest.sessionId === sessionId) void openFile(openRequest.path);
    // 依存は seq だけを見る（sessionId・openFile の変化で同じ依頼を開き直さない）
  }, [openRequest?.seq]);

  const renderContent = () => {
    if (selected === null || content === null) return <EmptyState size="compact" title={t("ac.files.selectFile")} />;
    if (content.kind === "loading") return <EmptyState size="compact" title={t("ac.files.loading")} />;
    if (content.kind === "error") return <Callout variant="warning" title={t("ac.files.contentError")}>{selected}</Callout>;
    const v = content.value;
    if (v.status !== "ok") {
      return (
        <Callout variant="warning" title={t(REASON_KEYS[v.status], { size: "size" in v ? v.size : 0 })}>
          {selected}
        </Callout>
      );
    }
    return (
      <div className="ac-files__content">
        <div className="ac-files__content-path">{selected}</div>
        {v.kind === "markdown" ? <MarkdownView text={v.text} linkPolicy="file" /> : <pre className="ac-files__text">{v.text}</pre>}
      </div>
    );
  };

  const terms = norm(query).split(/\s+/).filter(Boolean);
  const allFiles = list.kind === "data" && list.value.status === "ok" ? list.value.files : [];
  const shownFiles = terms.length === 0 ? allFiles : allFiles.filter((f) => { const p = norm(f.path); return terms.every((w) => p.includes(w)); });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    // 検索欄に文字がある時の欄での Esc は、まず欄を空にするだけ（戻らない）
    if (e.target instanceof HTMLInputElement && query !== "") {
      setQuery("");
      e.preventDefault();
      return;
    }
    e.preventDefault();
    onBackToTerminal?.();
  };

  const renderBody = () => {
    if (list.kind === "loading") return <EmptyState size="compact" title={t("ac.files.loading")} />;
    if (list.kind === "error") return <Callout variant="warning" title={t("ac.files.loadError")}>{t("ac.files.loadErrorBody")}</Callout>;
    if (list.value.status === "noSession") return <EmptyState size="compact" title={t("ac.files.reason.noSession")} />;
    if (list.value.files.length === 0) return <EmptyState size="compact" title={t("ac.files.emptyTitle")} description={t("ac.files.emptyBody")} />;
    return (
      <div className="ac-files__body">
        {shownFiles.length === 0 ? (
          <div className="ac-files__list">
            <EmptyState size="compact" title={t("ac.files.searchNone")} />
          </div>
        ) : (
        <ul className="ac-files__list" aria-label={t("ac.files.fileList")}>
          {shownFiles.map((f) => (
            <li key={f.path} className="ac-files__item">
              <Button variant="ghost" size="sm" layoutClassName="ac-files__file" aria-current={selected === f.path ? "true" : undefined} title={f.path} onClick={() => void openFile(f.path)}>
                <span className="ac-files__name">{f.name}</span>
                <span className="ac-files__dir">{f.dir}</span>
                <span className="ac-files__meta">
                  <span>{timeOf(f.lastAt)}</span>
                  {f.byAgent && (
                    <Badge variant="info" size="sm">
                      {t("ac.files.byAgent")}
                    </Badge>
                  )}
                </span>
              </Button>
            </li>
          ))}
        </ul>
        )}
        <div className="ac-files__view">{renderContent()}</div>
      </div>
    );
  };

  return (
    <div className="ac-files" hidden={!active} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="ac-files__toolbar">
        <Button size="sm" variant="outline" onClick={() => onBackToTerminal?.()}>
          {t("ac.files.backToTerminal")}
        </Button>
        <span className="ac-files__hint">{t("ac.files.hint")}</span>
        <TextField
          size="sm"
          className="ac-files__search"
          aria-label={t("ac.files.searchLabel")}
          placeholder={t("ac.files.searchLabel")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {terms.length > 0 && <span className="ac-files__count" data-testid="files-search-count">{t("ac.files.searchCount", { shown: shownFiles.length, total: allFiles.length })}</span>}
        <Button
          size="sm"
          variant="outline"
          layoutClassName="comp-btn-layout--ml-auto"
          onClick={() => {
            void loadList();
            if (selected !== null) void openFile(selected);
          }}
        >
          {t("ac.files.refresh")}
        </Button>
      </div>
      {renderBody()}
    </div>
  );
}
