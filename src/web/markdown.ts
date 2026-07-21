import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

export function renderMarkdown(source: string): string {
  const rendered = String(marked.parse(source, { async: false, gfm: true }));
  return sanitizeHtml(rendered, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote",
      "ul", "ol", "li", "strong", "em", "del", "code", "pre", "table", "thead",
      "tbody", "tr", "th", "td", "a",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      code: ["class"],
      th: ["align"],
      td: ["align"],
    },
    allowedClasses: { code: [/^language-[a-z0-9_-]+$/i] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  });
}
