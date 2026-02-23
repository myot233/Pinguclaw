import type { CQBuildPayload } from "./types";

type Segment = { type: string; data: Record<string, unknown> };

export function buildOutboundSegments(payload: CQBuildPayload): Segment[] {
  const segments: Segment[] = [];
  if (payload.replyToId) {
    segments.push({ type: "reply", data: { id: String(payload.replyToId) } });
  }
  for (const mention of payload.mentions ?? []) {
    const qq = String(mention).trim();
    if (!qq) {
      continue;
    }
    segments.push({ type: "at", data: { qq } });
    segments.push({ type: "text", data: { text: " " } });
  }
  const text = payload.text?.trim();
  if (text) {
    segments.push({ type: "text", data: { text } });
  }
  return segments;
}

