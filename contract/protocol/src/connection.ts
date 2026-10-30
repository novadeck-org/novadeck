export const protocolVersion = 1

/**
 * The largest incoming WebSocket message a runner accepts; every call must fit in one. A
 * look's picture never comes this way: only the desktop app takes them, over its port.
 */
export const maxWebSocketMessageBytes = 256 * 1024
