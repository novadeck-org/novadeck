import { compact } from "@novadeck/tui-input/box"

/**
 * The nonce of the doorbell line, or reply line, that is all a box holds (`text` as the box
 * reader gives it, wrapped anywhere, whitespace aside), as a failed ring left it; else
 * undefined. Any other text with it, or a second line, is not Novadeck's to submit. A reply
 * line's nonce opens and closes it, so text after it shows.
 */
export const leftoverNonce = (text: string): string | undefined => {
  const box = compact(text)
  return (
    /^\[Novadeck:automaticnotice,agentmessageswaiting,([A-Za-z0-9]+)\]$/.exec(box)?.[1] ??
    /^\[NovadeckInboxreply,([A-Za-z0-9]+)\](?:(?!\[NovadeckInboxreply,).)*\[\1\]$/.exec(box)?.[1]
  )
}
