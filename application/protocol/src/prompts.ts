/**
 * What a prompt may hold to be pasted into an agent's input box and submitted as a message
 * (`agents.prompt`), one rule for the runner, which refuses with `PROMPT_REFUSED`, and for
 * a client warning before it sends. Probed with each harness (2026-10-06 and 07).
 */

/** The text with its line breaks as line feeds: a CRLF or a lone CR is one line break. */
export const normalisedText = (text: string): string => text.replace(/\r\n?/g, "\n")

// C0 controls but the line feed and the tab, DEL, and C1 controls: the escape that would end a
// bracketed paste early and type what follows as keys, a Ctrl-U that clears the box.
// eslint-disable-next-line no-control-regex -- Control characters are what it finds.
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/**
 * Whether the text holds a control character an input box would take as a key. Line breaks
 * (CRLF, CR, LF) are text, and tabs.
 */
export const hasControlCharacters = (text: string): boolean => controls.test(normalisedText(text))

/**
 * Why a prompt can't be sent as a message, or undefined. Line breaks are normalised to line
 * feeds first, as the runner pastes them; control characters are looked for in the text as
 * pasted, its ends included, and the rest in the text trimmed, as a client sends it:
 * - nothing but white space;
 * - a control character, which would end the paste and press keys;
 * - a leading `/`, a slash command (Codex's "Unrecognized command" leaves the draft, a known
 *   one runs), or `!`, which runs the rest as a shell command in Claude Code, Codex and
 *   Antigravity;
 * - an `@name` at the very end, which leaves a file picker open (Codex's), whose Enter
 *   picks a file instead of submitting;
 * - a `$` at the very end, alone or with a name starting with an ASCII letter or `_`, which
 *   does the same with Codex's skill picker whatever follows in the name (probed: `$pdf2`,
 *   `$s3-upload`, `$a.b`, `$ns:skill` each took the Enter; `$5`, `$1.50`, `$-`, `$.x` and
 *   `$é` did not). `echo $HOME` ran, as no
 *   skill's name matched it, but the picker opens wherever one does, so a shell variable at
 *   the very end is refused all the same.
 * A trailing space or line break after an `@name` closes the picker in every harness, but
 * the text is judged trimmed, so it is refused all the same. `#`, `&` and `?` start nothing
 * in any harness (probed).
 */
export const promptRefusal = (text: string): string | undefined => {
  const pasted = normalisedText(text)
  if (controls.test(pasted))
    return "A message can't hold control characters: the agent would take them as keys."
  const trimmed = pasted.trim()
  if (trimmed === "") return "A message can't be empty."
  if (/^[/!]/.test(trimmed))
    return "A message can't start with / or !: the agent would read it as a command."
  if (/(^|\s)@\S*$/.test(trimmed))
    return "A message can't end in an @ mention: the agent would offer a file to pick."
  if (/(^|\s)\$(?:[A-Za-z_]\S*)?$/.test(trimmed))
    return "A message can't end in a $ skill mention: the agent would offer a skill to pick."
  return undefined
}
