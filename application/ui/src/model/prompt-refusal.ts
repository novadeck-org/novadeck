// Whether a text can't be given to an agent as a message, because its TUI would read it as
// something else: control characters (the C0 range but for tab and line breaks, CRLF and CR
// among them, DEL, and C1) act as keys, a leading `/` is a slash command and a leading `!` a
// shell command, which the
// chat's box sends as one when a command follows it, and a trailing `@name` or `$name`
// leaves a file or skill picker open that takes the Enter. The text is judged as it is
// sent, trimmed. This mirrors the protocol package's `promptRefusal`, which the runner
// refuses with PROMPT_REFUSED (see `backend/runner/prompt-refusal.test.ts`); keep the two
// alike, so the chat warns before the runner has to refuse.
// The text with its line breaks as line feeds: a CRLF or a lone CR is one line break.
const normalised = (text: string): string => text.replace(/\r\n?/g, "\n")

// Whether the text holds a control character an input box would take as a key. Line breaks
// (CRLF, CR, LF) are text, and tabs.
export const hasControlCharacters = (text: string): boolean =>
  // eslint-disable-next-line no-control-regex -- These are the characters it refuses.
  /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(normalised(text))

// The shell command a message gives, where it starts with `!`: the rest, trimmed.
export const shellCommand = (text: string): string | undefined => {
  const sent = normalised(text).trim()
  return sent.startsWith("!") ? sent.slice(1).trim() : undefined
}

// Whether a message with this text would be refused; with `shell`, a leading `!` and a
// command after it is a shell command, which goes. Control characters are looked for in
// the text as pasted, its ends included, the rest in the text trimmed. Text that is nothing
// but white space isn't refused here, though the protocol refuses it: the chat sends no
// empty message, and an option's words are optional, so there is nothing to warn about yet.
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

// What the person is told, before and after the runner's refusal.
export const promptRefusal =
  "A message can't start with / or !, or end in an @ or $ mention: the agent would read it as a command or a pick. Add a word around it and send again."

// The short warning shown beside a field as soon as its text has that shape.
export const promptHint =
  "Can't start with / or !, end in an @ or $ mention, or hold control characters. Add a word around it."

// The same for the chat's box, which sends a shell command.
export const messageHint = (text: string): string =>
  shellCommand(text) === undefined
    ? "Can't start with /, end in an @ or $ mention, or hold control characters. Add a word around it."
    : "A shell command can't end in an @ or $ mention, or hold control characters. Add a ; after it."

// The warning for words typed into a dialog's own field, or a form's text, that hold them.
export const controlHint = "Holds control characters the agent's field can't take."
