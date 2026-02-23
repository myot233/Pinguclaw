import type { CQParseResult } from "./types";

export function toPlainText(result: CQParseResult): string {
  const out: string[] = [];
  for (const seg of result.segments) {
    if (seg.type === "text") {
      const text = typeof seg.data.text === "string" ? seg.data.text : "";
      out.push(text);
      continue;
    }
    if (seg.type === "at") {
      const qq = String(seg.data.qq ?? "").trim();
      out.push(qq ? `@${qq}` : "@");
      continue;
    }
    if (seg.type === "image") {
      out.push("[image]");
      continue;
    }
    if (seg.type === "file") {
      out.push("[file]");
      continue;
    }
    if (seg.type === "record") {
      out.push("[audio]");
      continue;
    }
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

export function extractMentions(result: CQParseResult): string[] {
  return result.segments
    .filter((seg) => seg.type === "at")
    .map((seg) => String(seg.data.qq ?? "").trim())
    .filter(Boolean);
}

export function extractReplyId(result: CQParseResult): string | null {
  for (const seg of result.segments) {
    if (seg.type !== "reply") {
      continue;
    }
    const id = String(seg.data.id ?? "").trim();
    if (id) {
      return id;
    }
  }
  return null;
}

export function extractMediaRefs(
  result: CQParseResult,
): Array<{ type: "image" | "file" | "record"; value: string }> {
  const out: Array<{ type: "image" | "file" | "record"; value: string }> = [];
  for (const seg of result.segments) {
    if (seg.type !== "image" && seg.type !== "file" && seg.type !== "record") {
      continue;
    }
    const value = String(seg.data.url ?? seg.data.file ?? "").trim();
    if (!value) {
      continue;
    }
    out.push({ type: seg.type, value });
  }
  return out;
}

