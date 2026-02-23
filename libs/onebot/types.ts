

export type OneBotPostType = "message" | "notice" | "request" | "meta_event";

export type OneBotClientState =
    | "idle"
    | "connecting"
    | "open"
    | "closing"
    | "closed"
    | "reconnecting";

export interface OneBotBaseEvent {
    time: number;
    self_id: number;
    post_type: OneBotPostType;
    [key: string]: unknown;
}

export interface OneBotMessageEvent extends OneBotBaseEvent {
    post_type: "message";
    message_type?: "private" | "group" | (string & {});
    sub_type?: string;
    message_id?: number | string;
    user_id?: number;
    group_id?: number;
    message?: string | unknown[];
    raw_message?: string;
    font?: number;
    sender?: Record<string, unknown>;
}

export interface OneBotNoticeEvent extends OneBotBaseEvent {
    post_type: "notice";
    notice_type?: string;
    sub_type?: string;
    user_id?: number;
    group_id?: number;
}

export interface OneBotRequestEvent extends OneBotBaseEvent {
    post_type: "request";
    request_type?: string;
    sub_type?: string;
    user_id?: number;
    group_id?: number;
    comment?: string;
    flag?: string;
}

export interface OneBotMetaEvent extends OneBotBaseEvent {
    post_type: "meta_event";
    meta_event_type?: "lifecycle" | "heartbeat" | (string & {});
    sub_type?: string;
    status?: Record<string, unknown>;
    interval?: number;
}

export type OneBotEvent =
    | OneBotMessageEvent
    | OneBotNoticeEvent
    | OneBotRequestEvent
    | OneBotMetaEvent;

export interface OneBotActionRequest<TParams = Record<string, unknown>> {
    action: string;
    params?: TParams;
    echo?: string;
}

export type OneBotApiStatus = "ok" | "failed" | (string & {});

export interface OneBotApiResponse<TData = unknown> {
    status: OneBotApiStatus;
    retcode: number;
    data?: TData;
    echo?: string;
    wording?: string;
    [key: string]: unknown;
}

export interface OneBotClientError extends Error {
    code?: number | string;
    cause?: unknown;
}

export interface OneBotLogger {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
}

export interface OneBotWsClientOptions {
    url: string;
    accessToken?: string;
    reconnect?: boolean;
    reconnectMaxAttempts?: number;
    reconnectBaseDelayMs?: number;
    reconnectMaxDelayMs?: number;
    requestTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
    headers?: Record<string, string>;
    logger?: OneBotLogger;
}

export interface OneBotReconnectEvent {
    attempt: number;
    delayMs: number;
    reason?: string;
}

export interface OneBotCloseEvent {
    code: number;
    reason: string;
    wasClean: boolean;
}

export interface OneBotRawEvent {
    direction: "in" | "out";
    data: unknown;
}

export interface OneBotTimeoutEvent {
    action: string;
    echo: string;
    timeoutMs: number;
}

export type OneBotClientEventMap = {
    open: () => void;
    close: (event: OneBotCloseEvent) => void;
    reconnecting: (event: OneBotReconnectEvent) => void;
    error: (error: OneBotClientError) => void;
    raw: (event: OneBotRawEvent) => void;
    event: (event: OneBotEvent) => void;
    message: (event: OneBotMessageEvent) => void;
    notice: (event: OneBotNoticeEvent) => void;
    request: (event: OneBotRequestEvent) => void;
    meta_event: (event: OneBotMetaEvent) => void;
    response: (response: OneBotApiResponse<unknown>) => void;
    timeout: (event: OneBotTimeoutEvent) => void;
}; export type Listener<K extends keyof OneBotClientEventMap> = OneBotClientEventMap[K];
export type PendingRequest = {
    action: string;
    timeoutMs: number;
    resolve: (value: OneBotApiResponse<unknown>) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
};

