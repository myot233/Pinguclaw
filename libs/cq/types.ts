export type CQSegmentType =
  | "text"
  | "at"
  | "reply"
  | "image"
  | "file"
  | "record"
  | "unknown";

export type CQSegmentNormalized = {
  type: CQSegmentType;
  data: Record<string, unknown>;
  raw?: string;
};

export type CQParseResult = {
  segments: CQSegmentNormalized[];
};

export type CQBuildPayload = {
  text?: string;
  replyToId?: string | null;
  mentions?: string[];
};

