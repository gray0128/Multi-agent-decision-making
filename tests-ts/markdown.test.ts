import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/web/markdown.js";

describe("sanitized Markdown rendering", () => {
  it("renders report structures used by deliberation output", () => {
    const html = renderMarkdown([
      "# 报告",
      "",
      "| 风险 | 等级 |",
      "|---|---|",
      "| 写入 | 高 |",
      "",
      "```ts",
      "const safe = true;",
      "```",
      "",
      "> 审查结论",
      "",
      "- 一级",
      "  - 二级",
      "",
      "[证据](https://example.com/report)",
    ].join("\n"));

    expect(html).toContain("<table>");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain('href="https://example.com/report"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("removes executable HTML, event handlers, and unsafe link protocols", () => {
    const html = renderMarkdown([
      '<script>alert("x")</script>',
      '<img src=x onerror="alert(1)">',
      '[unsafe](javascript:alert(1))',
      '[safe](https://example.com)',
    ].join("\n\n"));

    expect(html).not.toMatch(/<script|onerror|javascript:/i);
    expect(html).toContain('href="https://example.com"');
  });
});
