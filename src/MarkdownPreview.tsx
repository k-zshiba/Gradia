import {
  createElement,
  Fragment,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Nodes, PhrasingContent } from "mdast";
import { api, desktop } from "./api";
import {
  parseInlineMarkdown,
  referenceKey,
  type MarkdownDocument,
} from "./markdown";
import { SegmentView, type SegmentDisplay } from "./SegmentView";
import type { Segment } from "./types";

export function MarkdownPreview({
  document,
  visible,
  display,
  onJump,
  onError,
  images = {},
}: {
  document: MarkdownDocument;
  visible: Segment[];
  display: SegmentDisplay;
  onJump: (id: string) => void;
  onError: (error: unknown) => void;
  images?: Record<string, string>;
}) {
  const visibleIds = new Set(visible.map((s) => s.id));
  function link(
    url: string,
    children: ReactNode,
    title?: string | null,
  ): ReactNode {
    if (url.startsWith("#")) {
      let anchor: string;
      try {
        anchor = decodeURIComponent(url.slice(1));
      } catch {
        return children;
      }
      const id = document.anchors.get(anchor);
      return id ? (
        <a
          href={url}
          onClick={(e) => {
            e.preventDefault();
            onJump(id);
          }}
        >
          {children}
        </a>
      ) : (
        children
      );
    }
    try {
      const target = new URL(url);
      if (
        !["https:", "http:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        return children;
      return (
        <a
          href={target.href}
          title={title || undefined}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (desktop) {
              e.preventDefault();
              void api.open(target.href).catch(onError);
            }
          }}
        >
          {children}
        </a>
      );
    } catch {
      return (
        <span className="markdown-local-link" title={`参照先: ${url}`}>
          {children}
        </span>
      );
    }
  }
  function inline(nodes: PhrasingContent[]): ReactNode {
    return nodes.map((node, index) => {
      let content: ReactNode;
      switch (node.type) {
        case "text":
          content = node.value;
          break;
        case "strong":
          content = <strong>{inline(node.children)}</strong>;
          break;
        case "emphasis":
          content = <em>{inline(node.children)}</em>;
          break;
        case "delete":
          content = <del>{inline(node.children)}</del>;
          break;
        case "inlineCode":
          content = <code>{node.value}</code>;
          break;
        case "inlineMath":
          content = <code className="markdown-math">${node.value}$</code>;
          break;
        case "break":
          content = <br />;
          break;
        case "link":
          content = link(node.url, inline(node.children), node.title);
          break;
        case "linkReference": {
          const definition = document.definitions.get(
            referenceKey(node.identifier),
          );
          content = definition
            ? link(definition.url, inline(node.children), definition.title)
            : inline(node.children);
          break;
        }
        case "image":
        case "imageReference": {
          const url =
            node.type === "image"
              ? node.url
              : document.definitions.get(referenceKey(node.identifier))?.url;
          const source = url ? images[url] : undefined;
          content = (
            <MarkdownImage key={url} source={source} alt={node.alt || "画像"} />
          );
          break;
        }
        case "footnoteReference":
          content = <sup>[{node.identifier}]</sup>;
          break;
        case "html":
          content = <code>{node.value}</code>;
          break;
        default:
          content = null;
      }
      return <Fragment key={index}>{content}</Fragment>;
    });
  }
  function text(node: Nodes): ReactNode {
    return (document.nodeSegments.get(node) || []).map((segment) => (
      <Fragment key={segment.id}>
        {!display.bilingual && inline(document.gaps.get(segment.id) || [])}
        <SegmentView
          segment={segment}
          display={display}
          inline
          render={(_value, translated) =>
            translated ? (
              <TranslatedInline
                text={display.translations[segment.id].text}
                render={inline}
              />
            ) : (
              inline(document.originals.get(segment.id) || [])
            )
          }
          renderTranslation={(value) => (
            <TranslatedInline text={value} render={inline} />
          )}
        />
      </Fragment>
    ));
  }
  function block(node: Nodes): ReactNode {
    switch (node.type) {
      case "heading":
        return createElement(`h${node.depth}`, {}, text(node));
      case "paragraph":
        return <p>{text(node)}</p>;
      case "blockquote":
        return <blockquote>{children(node.children)}</blockquote>;
      case "list":
        return node.ordered ? (
          <ol start={node.start || 1}>{children(node.children)}</ol>
        ) : (
          <ul>{children(node.children)}</ul>
        );
      case "listItem":
        return (
          <li>
            {typeof node.checked === "boolean" && (
              <input
                type="checkbox"
                checked={node.checked}
                disabled
                aria-label={node.checked ? "完了" : "未完了"}
              />
            )}
            {children(node.children)}
          </li>
        );
      case "table":
        return (
          <div className="markdown-table">
            <table>
              <thead>
                <tr>
                  {node.children[0]?.children.map((cell, i) => (
                    <th
                      key={i}
                      style={{ textAlign: node.align?.[i] || undefined }}
                    >
                      {text(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.children.slice(1).map((row, i) => (
                  <tr key={i}>
                    {row.children.map((cell, j) => (
                      <td
                        key={j}
                        style={{ textAlign: node.align?.[j] || undefined }}
                      >
                        {text(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "code":
      case "math":
      case "html": {
        const segment = document.nodeSegments.get(node)?.[0];
        return segment ? (
          <SegmentView
            segment={segment}
            display={display}
            render={() => (
              <pre>
                <code>{node.value}</code>
              </pre>
            )}
            renderTranslation={() => null}
          />
        ) : null;
      }
      case "thematicBreak":
        return <hr />;
      case "footnoteDefinition":
        return (
          <aside className="markdown-footnote">
            <sup>[{node.identifier}]</sup>
            {children(node.children)}
          </aside>
        );
      default:
        return null;
    }
  }
  function children(nodes: Nodes[]): ReactNode {
    return nodes.map((node, i) => <Fragment key={i}>{block(node)}</Fragment>);
  }
  const included = document.root.children
    .map((node, i) =>
      (document.nodeSegments.get(node) || []).some((s) => visibleIds.has(s.id))
        ? i
        : -1,
    )
    .filter((i) => i >= 0);
  const first = included[0] ?? 0,
    last = included.at(-1) ?? document.root.children.length - 1;
  return (
    <div className="markdown-preview">
      {children(
        document.root.children.filter((node, i) => {
          const segments = document.nodeSegments.get(node) || [];
          return segments.length
            ? segments.some((s) => visibleIds.has(s.id))
            : i >= first && i <= last;
        }),
      )}
    </div>
  );
}

function MarkdownImage({ source, alt }: { source?: string; alt: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  // Loading the Markdown URL directly would let a document access the network or arbitrary files.
  if (
    source &&
    source !== failedSource &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(source)
  )
    return (
      <img
        className="markdown-image"
        src={source}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={(event) => setFailedSource(event.currentTarget.src)}
      />
    );
  return (
    <span className="markdown-image-placeholder" role="img" aria-label={alt}>
      画像: {alt}
    </span>
  );
}

function TranslatedInline({
  text,
  render,
}: {
  text: string;
  render: (nodes: PhrasingContent[]) => ReactNode;
}) {
  const nodes = useMemo(() => parseInlineMarkdown(text), [text]);
  return render(nodes);
}
