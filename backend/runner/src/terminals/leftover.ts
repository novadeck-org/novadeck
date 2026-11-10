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

/**
 * The nonce closing a box's text: a doorbell line's or a reply line's end, as a box too short
 * for the line shows it, its head out of sight; else undefined. Any bracket ends this way, so
 * only the line its ring typed under that nonce says it is one.
 */
export const closingNonce = (text: string): string | undefined =>
  /[,[]([A-Za-z0-9]+)\]$/.exec(compact(text))?.[1]

/**
 * Whether a box's text holds a doorbell line or reply line, with anything else beside it or not:
 * a ring's own line is never to be handed to the person as their words.
 */
export const holdsRingLine = (text: string): boolean =>
  /\[Novadeck:automaticnotice,agentmessageswaiting,|\[NovadeckInboxreply,/.test(compact(text))

/**
 * Whether a box's text is the plain doorbell line and nothing else, which holds no one's words,
 * unlike a reply line.
 */
export const ringNotice = (text: string): boolean =>
  leftoverNonce(text) !== undefined && !replyLeftover(text)

/** Whether a box's text is a reply line rather than the plain doorbell line. */
export const replyLeftover = (text: string): boolean =>
  compact(text).startsWith("[NovadeckInboxreply,")
