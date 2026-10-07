import { hasControlCharacters, normalised, shellCommand } from "../../model/prompt-refusal"

// The demo's copy of the rule the runner refuses a message by (the protocol's
// `promptRefusal`), so the demo warns and refuses much as the runner would without one:
// control characters act as keys, a leading `/` is a slash command and a leading `!` a
// shell command, which the chat's box sends as one when a command follows it, and a
// trailing `@name` or `$name` leaves a file or skill picker open that takes the Enter. The
// text is judged as it is sent, trimmed. The runner's backend asks the protocol's rule
// itself, so only the demo keeps a copy.
//
// Control characters are looked for in the text as pasted, its ends included, the rest in
// the text trimmed. Text that is nothing but white space isn't refused here, though the
// protocol refuses it (see `Conversations.refused`).
export const promptRefused = (
  text: string,
  { shell = false }: { readonly shell?: boolean } = {},
): boolean => {
  const sent = normalised(text).trim()
  if (sent === "") return false
  return (
    hasControlCharacters(text) ||
    (shell && sent.startsWith("!") ? shellCommand(sent) === "" : /^[/!]/.test(sent)) ||
    /(^|\s)@\S*$/.test(sent) ||
    /(^|\s)\$(?:[A-Za-z_]\S*)?$/.test(sent)
  )
}
