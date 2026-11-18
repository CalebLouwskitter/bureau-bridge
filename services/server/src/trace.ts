import { randomBytes } from "node:crypto";

// W3C Trace Context Level 1:
// traceparent = version "-" trace-id "-" parent-id "-" trace-flags
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

export interface TraceContext {
  version: string;
  traceId: string;
  parentId: string;
  traceFlags: string;
  raw: string;
}

function randomNonZeroHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

export function parseTraceparent(
  header: string | string[] | undefined | null,
): TraceContext | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  const match = TRACEPARENT_RE.exec(trimmed);
  if (!match) return undefined;
  const [, version, traceId, parentId, traceFlags] = match;
  if (
    version === "ff" ||
    traceId === ZERO_TRACE_ID ||
    parentId === ZERO_PARENT_ID
  ) {
    return undefined;
  }
  return {
    version,
    traceId,
    parentId,
    traceFlags,
    raw: `${version}-${traceId}-${parentId}-${traceFlags}`,
  };
}

export function generateTraceparent(sampled = true): TraceContext {
  const version = "00";
  const traceId = randomNonZeroHex(16);
  const parentId = randomNonZeroHex(8);
  const traceFlags = sampled ? "01" : "00";
  return {
    version,
    traceId,
    parentId,
    traceFlags,
    raw: `${version}-${traceId}-${parentId}-${traceFlags}`,
  };
}

export function extractOrCreateTraceparent(
  header: string | string[] | undefined | null,
): TraceContext {
  return parseTraceparent(header) ?? generateTraceparent();
}

export function createChildTraceparent(
  parent: string | TraceContext | undefined | null,
): TraceContext {
  const ctx =
    typeof parent === "string" || parent == null
      ? extractOrCreateTraceparent(parent)
      : parent;
  const parentId = randomNonZeroHex(8);
  return {
    version: "00",
    traceId: ctx.traceId,
    parentId,
    traceFlags: ctx.traceFlags,
    raw: `00-${ctx.traceId}-${parentId}-${ctx.traceFlags}`,
  };
}
