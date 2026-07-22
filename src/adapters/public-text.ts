const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const REASONIX_THINKING = /^\s*▎\s*thinking\s*$\n?/gim;
const REASONIX_METRICS = /^\s*·\s+\d+\s+tok\s+·.*$/gim;

function append(values: string[], content: unknown): void {
  if (typeof content === "string") values.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") values.push(block);
      else if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
        values.push((block as { text: string }).text);
      }
    }
  }
}

function parseDocuments(raw: string): { documents: Record<string, unknown>[]; structured: boolean } {
  const stripped = raw.trim();
  if (!stripped) return { documents: [], structured: false };
  const documents: Record<string, unknown>[] = [];
  let structured = false;
  try {
    const value: unknown = JSON.parse(stripped);
    if (Array.isArray(value)) {
      structured = true;
      documents.push(...value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)));
    } else if (typeof value === "object" && value !== null) {
      structured = true;
      documents.push(value as Record<string, unknown>);
    }
  } catch {
    for (const line of stripped.split("\n")) {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) documents.push(value as Record<string, unknown>);
      } catch { /* non-JSON progress line */ }
    }
  }
  return { documents, structured };
}

export function cleanPublicText(value: string): string {
  return value.replace(ANSI, "").replace(REASONIX_THINKING, "").replace(REASONIX_METRICS, "").trim();
}

export function publicText(raw: string): string {
  const stripped = raw.trim();
  if (!stripped) return "";
  const { documents, structured } = parseDocuments(raw);
  if (!documents.length) return structured ? "" : cleanPublicText(raw);
  const final: string[] = [];
  const messages: string[] = [];
  for (const item of documents) {
    if (typeof item.result === "string" && item.result.trim()) final.push(item.result);
    const nested = item.item;
    if (typeof nested === "object" && nested !== null && ["agent_message", "message"].includes(String((nested as { type?: unknown }).type))) {
      append(messages, (nested as { text?: unknown; content?: unknown }).text ?? (nested as { content?: unknown }).content);
    }
    const message = item.message;
    if (typeof message === "object" && message !== null && ["message_end", "turn_end"].includes(String(item.type)) && (message as { role?: unknown }).role === "assistant") {
      append(final, (message as { content?: unknown }).content);
    } else if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant" && !["message_start", "message_update"].includes(String(item.type))) {
      append(messages, (message as { content?: unknown }).content);
    }
    if (["assistant", "agent_message", "message"].includes(String(item.type)) && (item.type !== "message" || item.role === undefined || item.role === "assistant")) {
      append(messages, item.text ?? item.content);
    } else if (typeof item.text === "string" && (item.type === undefined || ["assistant", "agent_message", "message"].includes(String(item.type)))) {
      messages.push(item.text);
    }
  }
  return cleanPublicText([...new Set((final.length ? final : messages).map((value) => value.trim()).filter(Boolean))].join("\n"));
}

export function publicError(raw: string): string {
  const errors: string[] = [];
  for (const item of parseDocuments(raw).documents) {
    if (["cancelled", "canceled"].includes(String(item.stopReason).toLowerCase())) {
      errors.push(`调用已取消（stopReason: ${String(item.stopReason)}）`);
    }
    if (typeof item.errorMessage === "string") errors.push(item.errorMessage);
    const error = item.error;
    if (typeof error === "string") errors.push(error);
    else if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
      errors.push((error as { message: string }).message);
    }
    const message = item.message;
    if (typeof message === "object" && message !== null && typeof (message as { errorMessage?: unknown }).errorMessage === "string") {
      errors.push((message as { errorMessage: string }).errorMessage);
    }
    if (typeof message === "object" && message !== null && ["cancelled", "canceled"].includes(String((message as { stopReason?: unknown }).stopReason).toLowerCase())) {
      errors.push(`调用已取消（stopReason: ${String((message as { stopReason?: unknown }).stopReason)}）`);
    }
  }
  return cleanPublicText([...new Set(errors.map((value) => value.trim()).filter(Boolean))].join("\n"));
}
