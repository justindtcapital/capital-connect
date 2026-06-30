import { createElement, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// A markdown renderer tuned for the Query chat bubble. Renders headings, lists,
// GitHub-flavored tables, code, and links cleanly with the app's muted theme,
// instead of dumping raw "##"/"|" markdown as plain text.

type MdProps = Record<string, unknown>;

// Factory for a simple styled DOM element. Strips react-markdown's `node` prop
// (not a valid DOM attribute) without tripping the unused-var lint.
function tag(name: string, className: string) {
  return (props: MdProps): ReactElement => {
    const { node: _node, ...rest } = props;
    void _node;
    return createElement(name, { className, ...rest });
  };
}

const components = {
  h1: tag("h1", "text-base font-semibold mt-3 mb-1.5 first:mt-0"),
  h2: tag("h2", "text-sm font-semibold mt-3 mb-1.5 first:mt-0"),
  h3: tag("h3", "text-sm font-semibold mt-2 mb-1 first:mt-0"),
  h4: tag("h4", "text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2 mb-1 first:mt-0"),
  p: tag("p", "my-1.5 leading-relaxed first:mt-0 last:mb-0"),
  ul: tag("ul", "list-disc pl-5 my-1.5 space-y-0.5"),
  ol: tag("ol", "list-decimal pl-5 my-1.5 space-y-0.5"),
  li: tag("li", "leading-relaxed"),
  strong: tag("strong", "font-semibold"),
  em: tag("em", "italic"),
  hr: tag("hr", "my-3 border-border"),
  blockquote: tag("blockquote", "border-l-2 border-border pl-3 italic text-muted-foreground my-1.5"),
  code: tag("code", "rounded bg-background/70 px-1 py-0.5 text-[0.85em] font-mono"),
  pre: tag("pre", "overflow-x-auto rounded bg-background/70 p-2 my-1.5 text-xs"),
  tr: tag("tr", "border-b border-border/50 last:border-0"),
  th: tag("th", "text-left font-semibold px-2 py-1 border-b border-border whitespace-nowrap"),
  td: tag("td", "px-2 py-1 align-top"),
  a: (props: MdProps): ReactElement => {
    const { node: _node, ...rest } = props;
    void _node;
    return createElement("a", { target: "_blank", rel: "noopener noreferrer", className: "text-primary underline underline-offset-2", ...rest });
  },
  // Wrap tables so wide ones scroll horizontally inside the bubble.
  table: (props: MdProps): ReactElement => {
    const { node: _node, ...rest } = props;
    void _node;
    return createElement(
      "div",
      { className: "overflow-x-auto my-2" },
      createElement("table", { className: "w-full text-xs border-collapse", ...rest }),
    );
  },
} as Components;

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
