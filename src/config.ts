import z from "zod";
import { looseBool, looseNumber, looseString } from "../libs/zod-ext";

export const QQConfigSchema = z
  .object({
    wsUrl: z
      .preprocess(
        (value) => (value == null || String(value).trim() === "" ? "ws://127.0.0.1:3001" : value),
        z.string(),
      )
      .default("ws://127.0.0.1:3001"),
    accessToken: looseString.default(""),
    enabled: looseBool(true).default(true),
    name: looseString.default(""),
    requireMention: looseBool(true).default(true),
    keywordTriggers: looseString.default(""),
    allowedGroups: looseString.default(""),
    blockedUsers: looseString.default(""),
    historyLimit: looseNumber(0).default(0),
  })
  .passthrough();

export type QQConfig = z.infer<typeof QQConfigSchema>;

export function splitIdList(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

