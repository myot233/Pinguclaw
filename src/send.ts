import OneBotWsClient from "../libs/onebot/client";
import { buildOutboundSegments } from "../libs/cq";
import { CHANNEL_ID } from "./constants";

export type QQTarget = {
  kind: "private" | "group";
  id: number;
};

/**
 * 将用户输入的 QQ 目标字符串解析为统一的发送目标结构。
 *
 * 支持格式：
 * - `private:<id>` / `p:<id>`：显式私聊目标
 * - `group:<id>` / `g:<id>`：显式群聊目标
 * - `<id>`：默认按私聊处理
 *
 * 这里采用“严格解析”策略：不支持的格式直接抛错，避免误发到错误会话。
 */
export function parseQQTarget(raw: string): QQTarget {
  const input = raw.trim();
  const normalized = input.replace(new RegExp(`^(qq|${CHANNEL_ID}):`, "i"), "");
  const privateMatch = normalized.match(/^(?:private|p):(\d+)$/i);
  if (privateMatch) {
    return { kind: "private", id: Number.parseInt(privateMatch[1], 10) };
  }
  const groupMatch = normalized.match(/^(?:group|g):(\d+)$/i);
  if (groupMatch) {
    return { kind: "group", id: Number.parseInt(groupMatch[1], 10) };
  }
  if (/^\d+$/.test(normalized)) {
    return { kind: "private", id: Number.parseInt(normalized, 10) };
  }
  throw new Error(`Unsupported qq target: ${raw}`);
}

/**
 * 基于统一目标执行 QQ 发送。
 *
 * 职责：
 * - 根据 `target.kind`（private/group）分发到对应 OneBot API
 * - 将 OneBot 的返回语义统一为一致的成功/失败契约
 * - 若 OneBot 返回 `message_id`，向上透传以便后续追踪或回复
 *
 * `message` 支持两种形式：
 * - 普通字符串（纯文本发送）
 * - CQ segment 数组（可承载 reply/at 等结构化信息）
 */
export async function sendByTarget(
  client: OneBotWsClient,
  target: QQTarget,
  message: string | Array<{ type: string; data: Record<string, unknown> }>,
): Promise<{ ok: true; messageId?: string }> {
  const resp =
    target.kind === "group"
      ? await client.sendGroupMsg(target.id, message)
      : await client.sendPrivateMsg(target.id, message);
  if (resp.status !== "ok" || resp.retcode !== 0) {
    throw new Error(
      resp.wording || `OneBot send failed (retcode=${resp.retcode})`,
    );
  }
  return {
    ok: true,
    messageId:
      String(
        (resp.data as { message_id?: string | number } | undefined)?.message_id,
      ) ?? undefined,
  };
}

/**
 * QQ 出站文本发送的高层入口。
 *
 * 流程：
 * 1) 解析并校验 `to`，得到 private/group 目标
 * 2) 构建出站 CQ segments（含可选 reply 上下文）
 * 3) 做一个轻量优化：
 *    - 如果仅为纯文本，则直接按字符串发送
 *    - 否则按 segment 数组发送，保留更丰富语义
 * 4) 实际发送与错误语义统一交给 `sendByTarget`
 *
 * 这样可以让 channel/outbound 层保持简洁，把目标解析、CQ 组装、
 * OneBot 分发逻辑集中到一个模块维护。
 */
export async function dispatchQQMessage(params: {
  client: OneBotWsClient;
  to: string;
  text: string;
  replyToId?: string | null;
}): Promise<{ ok: true; messageId?: string  }> {
  const target = parseQQTarget(params.to);
  const segments = buildOutboundSegments({
    text: params.text,
    replyToId: params.replyToId,
  });
  if (segments.length <= 1 && segments[0]?.type === "text") {
    return sendByTarget(
      params.client,
      target,
      String(segments[0]?.data?.text ?? ""),
    );
  }
  return sendByTarget(params.client, target, segments);
}
