import { maxWebSocketMessageBytes } from "@novadeck/protocol"

// Room for the request around a text in its WebSocket message.
const envelopeBytes = 8 * 1024

/**
 * Whether the runner takes `text` in one call: within `limit`, its own length limit for it, and,
 * JSON-escaped inside the request, within one WebSocket message, past which the socket closes
 * the whole link.
 */
export const fitsRunner = (text: string, limit: number): boolean =>
  text.length <= limit &&
  new TextEncoder().encode(JSON.stringify(text)).length <= maxWebSocketMessageBytes - envelopeBytes
