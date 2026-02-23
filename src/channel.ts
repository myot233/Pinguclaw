import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import OneBotWsClient from "../libs/onebot/client";
import {
  listQQAccountIds,
  resolveDefaultQQAccountId,
  resolveQQAccount,
  type ResolvedQQAccount,
} from "./accounts";
import { QQConfigSchema } from "./config";
import { CHANNEL_ID } from "./constants";
import { attachQQMessageHandler } from "./monitor";
import { dispatchQQMessage } from "./send";

const clients = new Map<string, OneBotWsClient>();
const detachInboundHandlers = new Map<string, () => void>();

function createClient(account: ResolvedQQAccount): OneBotWsClient {
  return new OneBotWsClient({
    url: account.config.wsUrl,
    accessToken: account.config.accessToken || undefined,
    logger: {
      info: (...args) => console.log(`[${CHANNEL_ID}]`, ...args),
      warn: (...args) => console.warn(`[${CHANNEL_ID}]`, ...args),
      error: (...args) => console.error(`[${CHANNEL_ID}]`, ...args),
    },
  });
}

async function ensureSendClient(cfg: OpenClawConfig, accountId?: string | null): Promise<{
  client: OneBotWsClient;
  temporary: boolean;
}> {
  const resolved = resolveQQAccount({ cfg, accountId });
  const existing = clients.get(resolved.accountId);
  if (existing && existing.getState() === "open") {
    return { client: existing, temporary: false };
  }
  const temporary = !existing;
  const client = existing ?? createClient(resolved);
  if (client.getState() !== "open") {
    await client.connect();
  }
  if (!existing) {
    clients.set(resolved.accountId, client);
  }
  return { client, temporary };
}

export const QQChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "PinguClaw QQ",
    selectionLabel: "PinguClaw QQ (OneBot v11)",
    docsPath: "/channels/pinguclaw",
    docsLabel: "pinguclaw",
    blurb: "PinguClaw QQ channel plugin via OneBot v11 websocket.",
    aliases: ["qq-pingu", "onebot"],
    quickstartAllowFrom: false,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    blockStreaming: true,
    media: false,
    threads: false,
    polls: false,
    reactions: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => listQQAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultQQAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        clearBaseFields: ["wsUrl", "accessToken", "name"],
      }),
    isEnabled: (account) => account.enabled !== false,
    isConfigured: (account) => account.configured === true,
    unconfiguredReason: () => "missing wsUrl",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      dmPolicy: "n/a",
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      const wsUrl = String((input as { wsUrl?: string }).wsUrl ?? "").trim();
      if (!wsUrl) {
        return "PinguClaw QQ requires --ws-url";
      }
      if (!/^wss?:\/\//i.test(wsUrl)) {
        return "PinguClaw QQ wsUrl must start with ws:// or wss://";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: CHANNEL_ID,
            })
          : namedConfig;
      const current = (next.channels as Record<string, unknown> | undefined)?.[
        CHANNEL_ID
      ] as
        | {
            accounts?: Record<string, Record<string, unknown> | undefined>;
            [key: string]: unknown;
          }
        | undefined;

      const newConfig = {
        wsUrl: (input as { wsUrl?: string }).wsUrl || "ws://127.0.0.1:3001",
        accessToken: (input as { accessToken?: string }).accessToken,
        enabled: true,
      };

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            [CHANNEL_ID]: { ...current, ...newConfig },
          },
        };
      }

      return {
        ...next,
        channels: {
          ...next.channels,
          [CHANNEL_ID]: {
            ...current,
            enabled: true,
            accounts: {
              ...current?.accounts,
              [accountId]: {
                ...current?.accounts?.[accountId],
                ...newConfig,
              },
            },
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim().replace(/^(qq|pinguclaw):/i, ""),
    targetResolver: {
      looksLikeId: (raw) => /^(?:(?:private|p|group|g):)?\d+$/i.test(raw.trim()),
      hint: "<private:qq|group:gid>",
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveQQAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (!account.configured) {
        throw new Error(
          `PinguClaw QQ is not configured for account "${account.accountId}"`,
        );
      }

      let client = clients.get(account.accountId);
      if (!client) {
        client = createClient(account);
        clients.set(account.accountId, client);
      }

      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: account.accountId,
        running: true,
        connected: false,
        lastStartAt: Date.now(),
        lastError: null,
      });

      client.on("open", () => {
        ctx.setStatus({
          ...ctx.getStatus(),
          connected: true,
          running: true,
          lastConnectedAt: Date.now(),
        });
      });
      client.on("close", (event) => {
        ctx.setStatus({
          ...ctx.getStatus(),
          connected: false,
          lastDisconnect: {
            at: Date.now(),
            status: event.code,
            error: event.reason,
          },
        });
      });
      client.on("error", (error) => {
        ctx.setStatus({
          ...ctx.getStatus(),
          lastError: error.message,
          connected: client?.getState() === "open",
        });
      });
      client.on("message", () => {
        ctx.setStatus({
          ...ctx.getStatus(),
          lastInboundAt: Date.now(),
        });
      });
      client.on("response", () => {
        ctx.setStatus({
          ...ctx.getStatus(),
          lastOutboundAt: Date.now(),
        });
      });

      await client.connect();
      detachInboundHandlers.get(account.accountId)?.();
      detachInboundHandlers.set(
        account.accountId,
        attachQQMessageHandler({
          client,
          cfg: ctx.cfg,
          account,
        }),
      );

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stopAccount: async (ctx) => {
      const account = resolveQQAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const client = clients.get(account.accountId);
      detachInboundHandlers.get(account.accountId)?.();
      detachInboundHandlers.delete(account.accountId);
      if (client) {
        await client.disconnect();
        clients.delete(account.accountId);
      }
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const { client, temporary } = await ensureSendClient(cfg, accountId);
      try {
        const result = await dispatchQQMessage({
          client,
          to,
          text,
          replyToId: replyToId ?? null,
        });
        return {
          channel: CHANNEL_ID,
          ok: true,
          messageId: result.messageId ?? "0",
        };
      } finally {
        if (temporary) {
          await client.disconnect();
          clients.delete(resolveQQAccount({ cfg, accountId }).accountId);
        }
      }
    },
  },
};

