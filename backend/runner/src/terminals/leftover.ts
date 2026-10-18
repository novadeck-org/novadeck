import { compact } from "@novadeck/tui-input/box"

/**
 * The nonce of the doorbell line that is all a box holds (`text` as the box reader gives
 * it, wrapped anywhere, whitespace aside), as a failed ring left it; else undefined. Any
 * other text with it, or a second line, is not Novadeck's to submit.
 */
export const leftoverNonce = (text: string): string | undefined =>
  /^\[Novadeck:automaticnotice,agentmessageswaiting,([A-Za-z0-9]+)\]$/.exec(compact(text))?.[1]
