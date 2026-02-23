import type { CQParseResult, CQSegmentNormalized } from "./types";

function parseCQBody(body: string): CQSegmentNormalized {
  const raw = `[CQ:${body}]`;
  const [typePart, ...rest] = body.split(",");
  const type = typePart?.trim() || "unknown";
  const data: Record<string, unknown> = {};
  const attrs = rest.join(",");
  if (attrs) {
    for (const kv of attrs.split(",")) {
      const idx = kv.indexOf("=");
      if (idx <= 0) {
        continue;
      }
      const key = kv.slice(0, idx).trim();
      const value = kv.slice(idx + 1).trim().replace(/&amp;/g, "&");
      data[key] = value;
    }
  }
  if (type === "text" || type === "at" || type === "reply" || type === "image" || type === "file" || type === "record") {
    return { type, data, raw };
  }
  return { type: "unknown", data: { cqType: type, ...data }, raw };
}

function parseStringInput(input: string): CQSegmentNormalized[] {
  const segments: CQSegmentNormalized[] = [];
  const re = /\[CQ:([^[\]]+)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) != null) {
    if (match.index > cursor) {
      segments.push({
        type: "text",
        data: { text: input.slice(cursor, match.index) },
      });
    }
    segments.push(parseCQBody(match[1]));
    cursor = match.index + match[0].length;
  }

  if (cursor < input.length) {
    segments.push({
      type: "text",
      data: { text: input.slice(cursor) },
    });
  }

  if (!segments.length) {
    segments.push({ type: "text", data: { text: input } });
  }
  return segments;
}

function parseArrayInput(input: unknown[]): CQSegmentNormalized[] {
  const segments: CQSegmentNormalized[] = [];
  for (const item of input) {
    const seg = item as { type?: unknown; data?: unknown };
    const type = typeof seg?.type === "string" ? seg.type : "unknown";
    const data = typeof seg?.data === "object" && seg.data != null ? (seg.data as Record<string, unknown>) : {};
    if (type === "text" || type === "at" || type === "reply" || type === "image" || type === "file" || type === "record") {
      segments.push({ type, data });
      continue;
    }
    segments.push({ type: "unknown", data: { cqType: type, ...data } });
  }
  return segments;
}

export function parseInboundCQ(input: string | unknown[] | undefined | null): CQParseResult {
  if (typeof input === "string") {
    return { segments: parseStringInput(input) };
  }
  if (Array.isArray(input)) {
    return { segments: parseArrayInput(input) };
  }
  return { segments: [] };
}

