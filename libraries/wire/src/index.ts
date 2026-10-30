export {
  portChannel,
  socketChannel,
  type Channel,
  type MessagePortLike,
  type WebSocketLike,
} from "./channel.js"
export { hasCode, normalize, WireError, wireErrors, type WireErrorCode } from "./errors.js"
export { wireContract, type WireContract } from "./handshake.js"
