import WebSocket from "ws";
import type {
    Listener,
  OneBotActionRequest,
  OneBotApiResponse,
  OneBotClientError,
  OneBotClientEventMap,
  OneBotClientState,
  OneBotCloseEvent,
  OneBotMessageEvent,
  OneBotReconnectEvent,
  OneBotTimeoutEvent,
  OneBotWsClientOptions,
  PendingRequest,
} from "./types";
import { DEFAULT_RECONNECT_ENABLED, DEFAULT_RECONNECT_BASE_DELAY_MS, DEFAULT_RECONNECT_MAX_ATTEMPTS, DEFAULT_RECONNECT_MAX_DELAY_MS, DEFAULT_REQUEST_TIMEOUT_MS } from "./const";
import { clampMs, createClientError, toReason, toText, isApiResponsePacket, isEventPacket } from "./util";

// OneBot客户端, 对OneBot协议下的消息接收和发送进行封装, 支持反向WebSocket连接。
export default class OneBotWsClient {
  private readonly options: Required<
    Pick<
      OneBotWsClientOptions,
      | "url"
      | "reconnect"
      | "reconnectBaseDelayMs"
      | "reconnectMaxAttempts"
      | "reconnectMaxDelayMs"
      | "requestTimeoutMs"
    >
  > &
    Omit<
      OneBotWsClientOptions,
      | "url"
      | "reconnect"
      | "reconnectBaseDelayMs"
      | "reconnectMaxAttempts"
      | "reconnectMaxDelayMs"
      | "requestTimeoutMs"
    >;

  private ws: WebSocket | null = null;
  private state: OneBotClientState = "idle";
  private manuallyClosed = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private echoSeq = 0;

  private readonly listeners: {
    [K in keyof OneBotClientEventMap]: Set<OneBotClientEventMap[K]>;
  } = {
    open: new Set(),
    close: new Set(),
    reconnecting: new Set(),
    error: new Set(),
    raw: new Set(),
    event: new Set(),
    message: new Set(),
    notice: new Set(),
    request: new Set(),
    meta_event: new Set(),
    response: new Set(),
    timeout: new Set(),
  };

  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(options: OneBotWsClientOptions) {
    this.options = {
      ...options,
      reconnect: options.reconnect ?? DEFAULT_RECONNECT_ENABLED,
      reconnectBaseDelayMs: clampMs(
        options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
        DEFAULT_RECONNECT_BASE_DELAY_MS,
      ),
      reconnectMaxAttempts: clampMs(
        options.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS,
        DEFAULT_RECONNECT_MAX_ATTEMPTS,
      ),
      reconnectMaxDelayMs: clampMs(
        options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
        DEFAULT_RECONNECT_MAX_DELAY_MS,
      ),
      requestTimeoutMs: clampMs(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      url: options.url,
    };
  }

  public getState(): OneBotClientState {
    return this.state;
  }

  public on<K extends keyof OneBotClientEventMap>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  public off<K extends keyof OneBotClientEventMap>(event: K, listener: Listener<K>): void {
    this.listeners[event].delete(listener);
  }

  public async connect(): Promise<void> {
    if (this.state === "open") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.transitionTo("connecting");

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;

      const headers: Record<string, string> = { ...(this.options.headers ?? {}) };
      if (this.options.accessToken) {
        headers.Authorization = `Bearer ${this.options.accessToken}`;
      }

      const ws = new WebSocket(this.options.url, { headers });
      this.ws = ws;

      ws.on("open", () => {
        opened = true;
        this.reconnectAttempt = 0;
        this.lastInboundAt = Date.now();
        this.startHeartbeatMonitor();
        this.transitionTo("open");
        this.emit("open");

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (rawData: unknown) => {
        this.lastInboundAt = Date.now();
        this.handleInbound(rawData);
      });

      ws.on("error", (error:Error) => {
        this.options.logger?.error?.("[onebot] websocket error", error);
        this.emit("error", createClientError("WebSocket error", error));
        if (!opened && !settled) {
          settled = true;
          reject(createClientError("WebSocket connect failed", error));
        }
      });

      ws.on("close", (code: number, reasonBuffer: Buffer) => {
        const reason = toReason(reasonBuffer);
        this.handleSocketClose({
          code,
          reason,
          wasClean: true,
        });
        if (!opened && !settled) {
          settled = true;
          reject(createClientError(`WebSocket closed before open (${code} ${reason})`));
        }
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  public async disconnect(code = 1000, reason = "manual disconnect"): Promise<void> {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopHeartbeatMonitor();
    this.transitionTo("closing");

    const ws = this.ws;
    if (!ws) {
      this.transitionTo("closed");
      this.rejectAllPending(createClientError("Disconnected"));
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      this.transitionTo("closed");
      this.rejectAllPending(createClientError("Disconnected"));
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      ws.once("close", finish);
      try {
        ws.close(code, reason);
      } catch {
        resolve();
      }
    });

    this.transitionTo("closed");
    this.rejectAllPending(createClientError("Disconnected"));
  }

  public async callAction<TData = unknown, TParams = Record<string, unknown>>(
    action: string,
    params?: TParams,
    options?: { timeoutMs?: number; echo?: string },
  ): Promise<OneBotApiResponse<TData>> {
    const ws = this.ws;
    if (!ws || this.state !== "open" || ws.readyState !== WebSocket.OPEN) {
      throw createClientError("WebSocket is not connected");
    }

    const timeoutMs = clampMs(options?.timeoutMs ?? this.options.requestTimeoutMs, this.options.requestTimeoutMs);
    const echo = options?.echo ?? this.generateEcho();
    const payload: OneBotActionRequest<TParams> = {
      action,
      params,
      echo,
    };

    this.emit("raw", { direction: "out", data: payload });

    return new Promise<OneBotApiResponse<TData>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        const timeoutEvent: OneBotTimeoutEvent = { action, echo, timeoutMs };
        this.emit("timeout", timeoutEvent);
        reject(createClientError(`OneBot action timeout: ${action} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(echo, {
        action,
        timeoutMs,
        resolve: (value) => resolve(value as OneBotApiResponse<TData>),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        const pending = this.pendingRequests.get(echo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(echo);
        }
        reject(createClientError(`Failed to send action: ${action}`, error));
      }
    });
  }

  public sendPrivateMsg(
    userId: number,
    message: string | unknown[],
  ): Promise<OneBotApiResponse<{ message_id?: number | string }>> {
    return this.callAction<{ message_id?: number | string }, { user_id: number; message: string | unknown[] }>(
      "send_private_msg",
      {
        user_id: userId,
        message,
      },
    );
  }

  public sendGroupMsg(
    groupId: number,
    message: string | unknown[],
  ): Promise<OneBotApiResponse<{ message_id?: number | string }>> {
    return this.callAction<{ message_id?: number | string }, { group_id: number; message: string | unknown[] }>(
      "send_group_msg",
      {
        group_id: groupId,
        message,
      },
    );
  }

  private emit<K extends keyof OneBotClientEventMap>(
    event: K,
    payload?: Parameters<OneBotClientEventMap[K]>[0],
  ): void {
    const eventListeners = this.listeners[event];
    if (!eventListeners.size) {
      return;
    }
    for (const listener of eventListeners) {
      try {
        (listener as (arg?: unknown) => void)(payload);
      } catch (error) {
        this.options.logger?.warn?.("[onebot] listener error", event, error);
      }
    }
  }

  private handleInbound(rawData: unknown): void {
    const text = toText(rawData);
    let payload: unknown;

    try {
      payload = JSON.parse(text) as unknown;
    } catch (error) {
      this.emit("raw", { direction: "in", data: text });
      this.emit("error", createClientError("Failed to parse inbound JSON", error));
      return;
    }

    this.emit("raw", { direction: "in", data: payload });

    if (isApiResponsePacket(payload)) {
      this.emit("response", payload);
      if (typeof payload.echo === "string") {
        const pending = this.pendingRequests.get(payload.echo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(payload.echo);
          pending.resolve(payload);
        }
      }
      return;
    }

    if (isEventPacket(payload)) {
      this.emit("event", payload);
      if (payload.post_type === "message") {
        this.emit("message", payload as OneBotMessageEvent);
      } else if (payload.post_type === "notice") {
        this.emit("notice", payload);
      } else if (payload.post_type === "request") {
        this.emit("request", payload);
      } else if (payload.post_type === "meta_event") {
        this.emit("meta_event", payload);
      }
      return;
    }

    this.emit("error", createClientError("Received unsupported OneBot payload"));
  }

  private handleSocketClose(event: OneBotCloseEvent): void {
    this.stopHeartbeatMonitor();
    this.ws = null;
    this.transitionTo("closed");
    this.emit("close", event);
    this.rejectAllPending(createClientError(`WebSocket closed (${event.code} ${event.reason})`));

    if (this.manuallyClosed) {
      return;
    }
    if (!this.options.reconnect) {
      return;
    }
    this.scheduleReconnect(`close:${event.code}`);
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) {
      return;
    }

    const nextAttempt = this.reconnectAttempt + 1;
    if (nextAttempt > this.options.reconnectMaxAttempts) {
      this.emit(
        "error",
        createClientError(
          `Reconnect exhausted after ${this.options.reconnectMaxAttempts} attempts (${reason})`,
        ),
      );
      return;
    }

    const exponentialDelay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * 2 ** (nextAttempt - 1),
    );
    const jitterMs = Math.floor(Math.random() * 300);
    const delayMs = exponentialDelay + jitterMs;
    this.transitionTo("reconnecting");

    const reconnectEvent: OneBotReconnectEvent = {
      attempt: nextAttempt,
      delayMs,
      reason,
    };
    this.emit("reconnecting", reconnectEvent);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt = nextAttempt;
      void this.connect().catch((error) => {
        this.emit("error", createClientError("Reconnect attempt failed", error));
        this.scheduleReconnect("connect_failed");
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    const timeoutMs = this.options.heartbeatTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }
    const checkInterval = Math.max(1000, Math.floor(timeoutMs / 2));
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt <= timeoutMs) {
        return;
      }
      this.emit("error", createClientError(`Heartbeat timeout after ${timeoutMs}ms`));
      try {
        this.ws?.close(4000, "heartbeat timeout");
      } catch (error) {
        this.emit("error", createClientError("Failed to close timed-out socket", error));
      }
    }, checkInterval);
  }

  private stopHeartbeatMonitor(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectAllPending(error: OneBotClientError): void {
    for (const [echo, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(echo);
    }
  }

  private transitionTo(next: OneBotClientState): void {
    this.state = next;
  }

  private generateEcho(): string {
    this.echoSeq += 1;
    return `ob_${Date.now()}_${this.echoSeq}`;
  }
}
