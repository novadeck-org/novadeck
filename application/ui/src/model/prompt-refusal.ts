// What the chat says of text an agent's TUI would read as more than a message, and the
// simple parts of that rule the chat's own fields use: control characters act as keys, and a
// leading `!` is a shell command. Whether a message is refused is the backend's to say
// (`Conversations.refused`), which the runner's backend asks of the protocol's
// `promptRefusal`, the rule the runner refuses with PROMPT_REFUSED.

// The text with its line breaks as line feeds: a CRLF or a lone CR is one line break.
export const normalised = (text: string): string => text.replace(/\r\n?/g, "\n")

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

// Whether the backend would refuse a text as a message (see `Conversations.refused`); with
// `shell`, a leading `!` and a command after it is a shell command, which goes.
export type Refused = (text: string, options?: { readonly shell?: boolean }) => boolean

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
