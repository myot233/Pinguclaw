import type { ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type OneBotWsClient from "../libs/onebot/client";
import { QQConfigSchema, type QQConfig } from "./config";
import { CHANNEL_ID } from "./constants";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotWsClient;
};

type QQChannelConfig = {
  enabled?: boolean;
  wsUrl?: string;
  accessToken?: string;
  name?: string;
  requireMention?: boolean;
  keywordTriggers?: string;
  allowedGroups?: string;
  blockedUsers?: string;
  historyLimit?: number;
  accounts?: Record<string, Record<string, unknown> | undefined>;
};

function readQQChannel(cfg: OpenClawConfig): QQChannelConfig {
  return (cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] as QQChannelConfig;
}

export function listQQAccountIds(cfg: OpenClawConfig): string[] {
  const qq = readQQChannel(cfg);
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  for (const id of Object.keys(qq?.accounts ?? {})) {
    ids.add(normalizeAccountId(id));
  }
  return Array.from(ids);
}

export function resolveDefaultQQAccountId(cfg: OpenClawConfig): string {
  const ids = listQQAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveQQAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedQQAccount {
  const accountId = normalizeAccountId(params.accountId);
  const qq = readQQChannel(params.cfg);
  const accountCfg =
    accountId === DEFAULT_ACCOUNT_ID ? undefined : (qq?.accounts?.[accountId] ?? undefined);

  const parsed = QQConfigSchema.parse({
    ...qq,
    ...accountCfg,
  });
  const enabled =
    accountCfg && typeof accountCfg.enabled === "boolean"
      ? accountCfg.enabled
      : (qq?.enabled ?? true);
  const name =
    (accountCfg && typeof accountCfg.name === "string" ? accountCfg.name : undefined) ??
    qq?.name ??
    undefined;

  return {
    accountId,
    name,
    enabled,
    configured: Boolean(parsed.wsUrl?.trim()),
    config: parsed,
  };
}
