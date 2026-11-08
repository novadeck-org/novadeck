/**
 * The words of a box's text and how many images lead it: Claude Code and Codex show a pasted
 * image as `[Image #N]` at the start of the box, ahead of the words, and put the same text back
 * when a Stop takes a queued message into the box. The numbers run on through a session, so
 * only how many is told. The words are trimmed.
 */
export const splitImages = (text: string): { readonly words: string; readonly marks: number } => {
  const lead = /^(?:\s*\[Image #\d+\])+/.exec(text)?.[0] ?? ""
  return { words: text.slice(lead.length).trim(), marks: lead.match(/\[Image #/g)?.length ?? 0 }
}
