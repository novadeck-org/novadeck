export {
  portChannel,
  socketChannel,
  type Channel,
  type MessagePortLike,
  type WebSocketLike,
} from "./channel.js"
export {
  hasCode,
  incompatibility,
  normalize,
  WireError,
  wireErrors,
  type Incompatibility,
  type WireErrorCode,
} from "./errors.js"
export { wireContract, type WireContract } from "./handshake.js"
export { readTolerantly } from "./read.js"
