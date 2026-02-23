import type { OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";
import type { OneBotMessageEvent } from "../libs/onebot/types";
import OneBotWsClient from "../libs/onebot/client";
import { extractMentions, extractReplyId, parseInboundCQ, toPlainText } from "../libs/cq";
import type { ResolvedQQAccount } from "./accounts";
import { CHANNEL_ID, CHANNEL_PROVIDER } from "./constants";
import { getQQRuntime } from "./runtime";
import { dispatchQQMessage } from "./send";
import { splitIdList } from "./config";

function buildTriggerKeywords(raw: string): string[] {
  return raw
    .split(/[,\n]/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isTriggeredInGroup(params: {
  plainText: string;
  mentions: string[];
  replyId: string | null;
  selfId: number;
  requireMention: boolean;
  keywords: string[];
}): boolean {
  if (!params.requireMention) {
    return true;
  }
  if (params.replyId) {
    return true;
  }
  if (params.mentions.includes(String(params.selfId)) || params.mentions.includes("all")) {
    return true;
  }
  const text = params.plainText.toLowerCase();
  return params.keywords.some((kw) => kw.length > 0 && text.includes(kw));
}

function buildInboundTarget(event: OneBotMessageEvent): string {
  if (event.message_type === "group" && event.group_id != null) {
    return `group:${event.group_id}`;
  }
  return `private:${event.user_id}`;
}

export function attachQQMessageHandler(params: {
  client: OneBotWsClient;
  cfg: OpenClawConfig;
  account: ResolvedQQAccount;
  logPrefix?: string;
}): () => void {
  const runtime = getQQRuntime();
  const blockedUsers = new Set(splitIdList(params.account.config.blockedUsers));
  const allowedGroups = new Set(splitIdList(params.account.config.allowedGroups));
  const keywords = buildTriggerKeywords(params.account.config.keywordTriggers);

  return params.client.on("message", async (event) => {
    try {
      if (!event.user_id || (event.message_type !== "private" && event.message_type !== "group")) {
        return;
      }

      const parsed = parseInboundCQ(
        (event.message as string | unknown[] | undefined) ?? event.raw_message ?? "",
      );
      const plainText = toPlainText(parsed);
      if (!plainText.trim()) {
        return;
      }

      const senderId = String(event.user_id);
      if (blockedUsers.has(senderId)) {
        return;
      }

      const isGroup = event.message_type === "group";
      if (isGroup && event.group_id == null) {
        return;
      }
      if (isGroup && allowedGroups.size > 0 && !allowedGroups.has(String(event.group_id))) {
        return;
      }

      const mentions = extractMentions(parsed);
      const replyId = extractReplyId(parsed);
      if (
        isGroup &&
        !isTriggeredInGroup({
          plainText,
          mentions,
          replyId,
          selfId: event.self_id,
          requireMention: params.account.config.requireMention,
          keywords,
        })
      ) {
        return;
      }

      const from = isGroup ? String(event.group_id) : `qq:user:${senderId}`;
      const route = runtime.channel.routing.resolveAgentRoute({
        cfg: params.cfg,
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
        peer: {
          kind: isGroup ? "group" : "direct",
          id: from,
        },
      });
      const to = buildInboundTarget(event);
      const deliver = async (payload: ReplyPayload) => {
        if (!payload.text || !payload.text.trim()) {
          return;
        }
        await dispatchQQMessage({
          client: params.client,
          to,
          text: payload.text,
          replyToId: isGroup ? String(event.message_id ?? "") : undefined,
        });
      };
      const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({
        deliver,
      });

      const ctxPayload = runtime.channel.reply.finalizeInboundContext({
        Provider: CHANNEL_PROVIDER,
        Channel: CHANNEL_ID,
        From: from,
        To: `${CHANNEL_PROVIDER}:bot`,
        Body: plainText,
        RawBody: plainText,
        SenderId: senderId,
        SenderName: String((event.sender as { nickname?: string } | undefined)?.nickname ?? ""),
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        Timestamp: event.time ? event.time * 1000 : Date.now(),
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: from,
      });

      await runtime.channel.session.recordInboundSession({
        storePath: runtime.channel.session.resolveStorePath(
          (params.cfg as { session?: { store?: string } }).session?.store,
          {
            agentId: route.agentId,
          },
        ),
        sessionKey: (ctxPayload as { SessionKey?: string }).SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: undefined,
        onRecordError: (err) => {
          console.warn(`${params.logPrefix ?? "[qq]"} session record error`, err);
        },
      });

      await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcher,
        replyOptions,
      });
    } catch (error) {
      console.error(`${params.logPrefix ?? "[qq]"} inbound error`, error);
    }
  });
}
