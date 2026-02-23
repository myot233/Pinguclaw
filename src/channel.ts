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
const detachLifecycleHandlers = new Map<string, () => void>();

function formatConnInfo(account: ResolvedQQAccount): string {
  return `wsUrl="${account.config.wsUrl}" accessToken="${account.config.accessToken || ""}"`;
}

function logInfo(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.log(`[${CHANNEL_ID}] ${message}`);
    return;
  }
  console.log(`[${CHANNEL_ID}] ${message}`, extra);
}

function logWarn(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.warn(`[${CHANNEL_ID}] ${message}`);
    return;
  }
  console.warn(`[${CHANNEL_ID}] ${message}`, extra);
}

function createClient(account: ResolvedQQAccount): OneBotWsClient {
  logInfo(
    `creating websocket client for account="${account.accountId}" ${formatConnInfo(account)}`,
  );
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
  logInfo(`resolving send client for account="${resolved.accountId}"`);
  const existing = clients.get(resolved.accountId);
  if (existing && existing.getState() === "open") {
    logInfo(`reusing opened client for account="${resolved.accountId}"`);
    return { client: existing, temporary: false };
  }
  const temporary = !existing;
  const client = existing ?? createClient(resolved);
  if (client.getState() !== "open") {
    logInfo(
      `connecting send client for account="${resolved.accountId}" ${formatConnInfo(resolved)}`,
      { temporary, state: client.getState() },
    );
    await client.connect();
    logInfo(`send client connected for account="${resolved.accountId}"`);
  }
  if (!existing) {
    clients.set(resolved.accountId, client);
    logInfo(`send client cached for account="${resolved.accountId}"`);
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
      console.log(ctx.log)
      ctx.log?.info?.(
        `[${CHANNEL_ID}] startAccount begin account="${account.accountId}" ${formatConnInfo(account)}`,
      );
      if (!account.configured) {
        ctx.log?.warn?.(
          `[${CHANNEL_ID}] startAccount blocked: account="${account.accountId}" not configured`,
        );
        throw new Error(
          `PinguClaw QQ is not configured for account "${account.accountId}"`,
        );
      }

      let client = clients.get(account.accountId);
      if (!client) {
        client = createClient(account);
        clients.set(account.accountId, client);
        ctx.log?.info?.(`[${CHANNEL_ID}] created runtime client account="${account.accountId}"`);
      } else {
        ctx.log?.info?.(
          `[${CHANNEL_ID}] reuse runtime client account="${account.accountId}" state="${client.getState()}"`,
        );
      }

      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: account.accountId,
        running: true,
        connected: false,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // 防止网关重复启动同一 account 时重复绑定事件监听，导致日志和状态更新被放大。
      detachLifecycleHandlers.get(account.accountId)?.();
      const offOpen = client.on("open", () => {
        ctx.log?.info?.(`[${CHANNEL_ID}] websocket opened account="${account.accountId}"`);
        ctx.setStatus({
          ...ctx.getStatus(),
          connected: true,
          running: true,
          lastConnectedAt: Date.now(),
        });
      });
      const offClose = client.on("close", (event) => {
        ctx.log?.warn?.(
          `[${CHANNEL_ID}] websocket closed account="${account.accountId}" code=${event.code} reason="${event.reason}"`,
        );
        if (event.code === 1005) {
          ctx.log?.warn?.(
            `[${CHANNEL_ID}] close code=1005 表示对端未发送 close frame，常见于 wsUrl 不匹配、鉴权失败或网关主动断开`,
          );
        }
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
      const offError = client.on("error", (error) => {
        ctx.log?.error?.(
          `[${CHANNEL_ID}] websocket error account="${account.accountId}" message="${error.message}"`,
        );
        ctx.setStatus({
          ...ctx.getStatus(),
          lastError: error.message,
          connected: client?.getState() === "open",
        });
      });
      const offReconnect = client.on("reconnecting", (event) => {
        ctx.log?.warn?.(
          `[${CHANNEL_ID}] reconnecting account="${account.accountId}" attempt=${event.attempt} delayMs=${event.delayMs} reason="${event.reason}"`,
        );
      });
      const offMessage = client.on("message", () => {
        ctx.setStatus({
          ...ctx.getStatus(),
          lastInboundAt: Date.now(),
        });
      });
      const offResponse = client.on("response", () => {
        ctx.setStatus({
          ...ctx.getStatus(),
          lastOutboundAt: Date.now(),
        });
      });
      detachLifecycleHandlers.set(account.accountId, () => {
        offOpen();
        offClose();
        offError();
        offReconnect();
        offMessage();
        offResponse();
      });

      ctx.log?.info?.(`[${CHANNEL_ID}] connecting websocket account="${account.accountId}"`);
      await client.connect();
      ctx.log?.info?.(`[${CHANNEL_ID}] connect finished account="${account.accountId}"`);
      detachInboundHandlers.get(account.accountId)?.();
      detachInboundHandlers.set(
        account.accountId,
        attachQQMessageHandler({
          client,
          cfg: ctx.cfg,
          account,
        }),
      );
      ctx.log?.info?.(`[${CHANNEL_ID}] inbound handler attached account="${account.accountId}"`);

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          ctx.log?.info?.(
            `[${CHANNEL_ID}] startAccount aborted before wait account="${account.accountId}"`,
          );
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            ctx.log?.info?.(`[${CHANNEL_ID}] startAccount abort received account="${account.accountId}"`);
            resolve();
          },
          { once: true },
        );
      });
    },
    stopAccount: async (ctx) => {
      const account = resolveQQAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      ctx.log?.info?.(`[${CHANNEL_ID}] stopAccount begin account="${account.accountId}"`);
      const client = clients.get(account.accountId);
      detachInboundHandlers.get(account.accountId)?.();
      detachInboundHandlers.delete(account.accountId);
      detachLifecycleHandlers.get(account.accountId)?.();
      detachLifecycleHandlers.delete(account.accountId);
      if (client) {
        ctx.log?.info?.(
          `[${CHANNEL_ID}] disconnecting websocket account="${account.accountId}" state="${client.getState()}"`,
        );
        await client.disconnect();
        clients.delete(account.accountId);
        ctx.log?.info?.(`[${CHANNEL_ID}] websocket disconnected account="${account.accountId}"`);
      } else {
        ctx.log?.warn?.(`[${CHANNEL_ID}] stopAccount no client found account="${account.accountId}"`);
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
        logInfo(`dispatch outbound message account="${resolveQQAccount({ cfg, accountId }).accountId}"`);
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
          logInfo("closing temporary send client");
          await client.disconnect();
          const resolved = resolveQQAccount({ cfg, accountId });
          clients.delete(resolved.accountId);
          logInfo(`temporary send client closed account="${resolved.accountId}"`);
        }
      }
    },
  },
};
