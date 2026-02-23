import type { OneBotClientError, OneBotEvent, OneBotApiResponse } from "./types";


export function createClientError(message: string, cause?: unknown): OneBotClientError {
    const err = new Error(message) as OneBotClientError;
    err.cause = cause;
    return err;
}
export function toText(data: unknown): string {
    if (typeof data === "string") {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data)) {
        const chunks = data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(entry as ArrayBuffer)));
        return Buffer.concat(chunks).toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
    }
    return String(data);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}
export function isEventPacket(value: unknown): value is OneBotEvent {
    return isRecord(value) && typeof value.post_type === "string";
}
export function isApiResponsePacket(value: unknown): value is OneBotApiResponse<unknown> {
    return isRecord(value) && typeof value.status === "string" && typeof value.retcode === "number";
}
export function toReason(reason: Buffer): string {
    try {
        return reason.toString("utf8");
    } catch {
        return "";
    }
}
export function clampMs(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value < 0) {
        return fallback;
    }
    return Math.floor(value);
}
