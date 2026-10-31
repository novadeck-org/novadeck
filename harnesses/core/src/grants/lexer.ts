// The strict POSIX lexer (approvals-design.md, Appendix A1): one simple command, or a refusal.
// Anything a shell would expand, split, redirect or chain is refused, never guessed at.

export type Lexed =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string }

const safeChar = /[A-Za-z0-9._/:=@%+,-]/
// Programs that run what follows them, or change where it runs; refused as the first word.
const wrappers = new Set(["env", "sudo", "command", "exec", "xargs", "cd"])
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"])
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/
// A word that may hold newlines: the one after --body.
const bodyFlags = new Set(["--body", "-b"])

/** The program a word names: its basename, lower-cased, without an executable suffix. */
export const programName = (word: string): string =>
  word
    .slice(word.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "")

const refuse = (reason: string): Lexed => ({ ok: false, reason })

/** Reads `command` as one simple command's words, or says why it is not one. */
export const lex = (command: string): Lexed => {
  const words: string[] = []
  let word = ""
  let open = false
  let i = 0
  while (i < command.length) {
    const char = command[i] as string
    if (char === " " || char === "\t") {
      if (open) words.push(word)
      word = ""
      open = false
      i += 1
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return refuse("unterminated single quote")
      const quoted = command.slice(i + 1, end)
      // Fish reads \' inside single quotes as an escape, so a backslash there is never literal.
      if (quoted.includes("\\")) return refuse("a backslash in single quotes")
      word += quoted
      open = true
      i = end + 1
    } else if (char === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        const inner = command[j] as string
        if (inner === "$" || inner === "`" || inner === "\\" || inner === "!")
          return refuse(`${inner} inside double quotes`)
        word += inner
        j += 1
      }
      if (j >= command.length) return refuse("unterminated double quote")
      open = true
      i = j + 1
    } else if (safeChar.test(char)) {
      if (!open && char === "=") return refuse("a word starting with =")
      word += char
      open = true
      i += 1
    } else {
      return refuse(`${JSON.stringify(char)} outside quotes`)
    }
  }
  if (open) words.push(word)

  const first = words[0]
  if (first === undefined) return refuse("empty command")
  if (assignment.test(first)) return refuse("a variable assignment before the command")
  const program = programName(first)
  if (wrappers.has(program)) return refuse(`a leading ${program}`)
  if (shells.has(program) && words.slice(1).some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)))
    return refuse(`${program} -c`)

  for (const [index, text] of words.entries()) {
    const body = bodyFlags.has(words[index - 1] ?? "")
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      if (code >= 0x20 && code <= 0x7e) continue
      if (ch === "\n" && body) continue
      return refuse(`${JSON.stringify(ch)} in a word`)
    }
  }
  return { ok: true, argv: words }
}
