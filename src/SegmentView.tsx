import type { ReactNode } from "react";
import type { Segment, Translation } from "./types";

export interface SegmentDisplay {
  chosen: Set<string>;
  translations: Record<string, Translation>;
  bilingual: boolean;
  peek: Set<string>;
  selection: string[];
  onPeek: (id: string) => void;
}

export function SegmentView({
  segment: s,
  display,
  inline = false,
  render,
  renderTranslation,
}: {
  segment: Segment;
  display: SegmentDisplay;
  inline?: boolean;
  render: (text: string, translated: boolean) => ReactNode;
  renderTranslation: (text: string) => ReactNode;
}) {
  const t = display.translations[s.id];
  const translated =
    display.chosen.has(s.id) &&
    t?.status === "ready" &&
    !display.peek.has(s.id);
  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper
      id={`segment-${s.id}`}
      data-segment={s.id}
      data-translated={translated ? "true" : "false"}
      className={`segment ${s.kind} ${translated && !display.bilingual ? "translated" : ""} ${display.bilingual && s.eligible ? "bilingual" : ""} ${display.selection.includes(s.id) ? "selected" : ""}`}
    >
      {render(
        !display.bilingual && translated ? t.text : s.text,
        !display.bilingual && translated,
      )}
      {display.bilingual && s.eligible && t?.status === "ready" && (
        <span className="bilingual-translation" lang="ja">
          <span className="translation-label">日本語</span>
          {renderTranslation(t.text)}
        </span>
      )}
      {!display.bilingual &&
        display.chosen.has(s.id) &&
        t?.status === "ready" && (
          <button
            className="original-toggle"
            onClick={() => display.onPeek(s.id)}
          >
            {display.peek.has(s.id) ? "訳文" : "原文"}
          </button>
        )}
      {display.chosen.has(s.id) && t?.status === "failed" && (
        <small className="translation-error" title={t.error}>
          翻訳失敗 · 原文を表示
        </small>
      )}
      {display.chosen.has(s.id) &&
        (!t || t.status === "pending") &&
        (display.bilingual ? (
          <small className="bilingual-waiting">日本語訳を準備中</small>
        ) : (
          <span className="pending-mark" title="翻訳待ち" />
        ))}
    </Wrapper>
  );
}
