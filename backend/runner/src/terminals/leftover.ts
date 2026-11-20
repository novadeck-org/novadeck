import { compact } from "@novadeck/tui-input/box"

// The forms of a ring's line as a box reader gives it, whitespace compacted away
// (`@novadeck/tui-input/box`): a tag, or the bracket line of before it (a session may still
// hold one). The quote of a tag's attributes is `"` as typed, or `'` as a task's start prompt.
const forms = {
  bell: [
    /^<novadeck-doorbellring=["']([A-Za-z0-9]+)["']from=["'][A-Za-z0-9_-]*["']\/>$/,
    /^\[Novadeck:automaticnotice,agentmessageswaiting,([A-Za-z0-9]+)\]$/,
  ],
  reply: [
    /^<novadeck-replyring="([A-Za-z0-9]+)">[^<]*<\/novadeck-reply><novadeck-endring="\1"\/>$/,
    /^\[NovadeckInboxreply,([A-Za-z0-9]+)\](?:(?!\[NovadeckInboxreply,).)*\[\1\]$/,
  ],
}

/**
 * The nonce of the doorbell line, or reply line, that is all a box holds (`text` as the box
 * reader gives it, wrapped anywhere, whitespace aside), as a failed ring left it; else
 * undefined. Any other text with it, or a second line, is not Novadeck's to submit. A reply
 * line's nonce opens and closes it, so text after it shows.
 */
export const leftoverNonce = (text: string): string | undefined => {
  const box = compact(text)
  return [...forms.bell, ...forms.reply].map((form) => form.exec(box)?.[1]).find(Boolean)
}

/**
 * The nonce closing a box's text: a doorbell line's end or a reply line's closing tag, as a box
 * too short for the line shows it, its head out of sight; else undefined. Any tag or bracket
 * ends this way, so only the line its ring typed under that nonce says it is one.
 */
export const closingNonce = (text: string): string | undefined => {
  const box = compact(text)
  return (
    /<novadeck-(?:end|doorbell)ring=["']([A-Za-z0-9]+)["'](?:from=["'][A-Za-z0-9_-]*["'])?\/>$/.exec(
      box,
    )?.[1] ?? /[,[]([A-Za-z0-9]+)\]$/.exec(box)?.[1]
  )
}

/**
 * Whether a box's text holds a doorbell line or reply line, with anything else beside it or not:
 * a ring's own line is never to be handed to the person as their words.
 */
export const holdsRingLine = (text: string): boolean =>
  /<novadeck-doorbellring=|<novadeck-replyring=|\[Novadeck:automaticnotice,agentmessageswaiting,|\[NovadeckInboxreply,/.test(
    compact(text),
  )

/**
 * Whether a box's text is the plain doorbell line and nothing else, which holds no one's words,
 * unlike a reply line.
 */
export const ringNotice = (text: string): boolean =>
  leftoverNonce(text) !== undefined && !replyLeftover(text)

/** Whether a box's text is a reply line rather than the plain doorbell line. */
export const replyLeftover = (text: string): boolean =>
  /^(?:<novadeck-replyring=|\[NovadeckInboxreply,)/.test(compact(text))
