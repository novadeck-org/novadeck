/**
 * A shell command line as words, for the shipping gate (see architecture/grants.md in the
 * workspace): split into simple commands at `&&`, `||`, `;`, `|`, `&` and line ends, each as
 * the words its program is given, with quotes taken off. It reads what a POSIX shell reads
 * statically and says when it can't: a word that holds an expansion (`$x`, `$(…)`, a
 * backtick, a glob's `*` is left as it is), a subshell or group, or a here-document's body
 * is not something it can tell the value of, so the command is `dynamic` and the gate never
 * allows it as a whole.
 */

/** What joined a command to the one before it (`start` for the first). */
export type Joint = "start" | "&&" | "||" | ";" | "|" | "&"

/** One simple command. */
export type Simple = {
  /** What joined it to the command before it. */
  readonly joint: Joint
  /** Its words, quotes taken off: the program first. Leading `NAME=value` words are in `assigns`. */
  readonly words: readonly string[]
  /** Its leading variable assignments, as written. */
  readonly assigns: readonly string[]
  /** Redirections it carries, as written (`2>&1`, `>out`). */
  readonly redirects: readonly string[]
  /** Its text as written, trimmed: what a user's rule is matched against. */
  readonly text: string
  /** Whether a word holds something a shell would expand to a value this can't tell. */
  readonly dynamic: boolean
}

export type Parsed = {
  readonly commands: readonly Simple[]
  /** Whether anything in the line is beyond a static reading: a subshell, a group, an expansion. */
  readonly dynamic: boolean
  /** Text read inside substitutions and subshells, each as its own line, so their commands can be seen. */
  readonly inner: readonly string[]
}

const operators = ["&&", "||", ";;", ";", "|&", "|", "&"] as const

/** Splits `line` as a shell would. */
export const parseShell = (line: string): Parsed => {
  const commands: Simple[] = []
  const inner: string[] = []
  let dynamicAll = false
  let words: string[] = []
  let assigns: string[] = []
  let redirects: string[] = []
  let dynamic = false
  let joint: Joint = "start"
  let start = 0
  // The word under way, and whether any of it was written (an empty quoted word counts).
  let word = ""
  let written = false
  const endWord = () => {
    if (!written) return
    written = false
    const text = word
    word = ""
    if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) assigns.push(text)
    else words.push(text)
  }
  const endCommand = (at: number, next: Joint) => {
    endWord()
    if (words.length > 0 || assigns.length > 0 || redirects.length > 0) {
      commands.push({
        joint,
        words,
        assigns,
        redirects,
        text: line.slice(start, at).trim(),
        dynamic,
      })
    }
    words = []
    assigns = []
    redirects = []
    dynamic = false
    joint = next
    start = at
  }
  let at = 0
  const n = line.length
  const heredocs: { delimiter: string; quoted: boolean; strip: boolean }[] = []
  while (at < n) {
    const c = line[at]!
    if (c === "\n") {
      endCommand(at, ";")
      at += 1
      start = at
      // A here-document's body follows the line that names it.
      for (const doc of heredocs.splice(0)) {
        for (;;) {
          if (at >= n) break
          const end = line.indexOf("\n", at)
          const text = end < 0 ? line.slice(at) : line.slice(at, end)
          at = end < 0 ? n : end + 1
          if ((doc.strip ? text.replace(/^\t+/, "") : text) === doc.delimiter) break
          // An unquoted body expands: a substitution in it is read as commands too.
          if (!doc.quoted && /\$\(|`/.test(text)) {
            dynamicAll = true
            inner.push(...substitutions(text))
          }
        }
        start = at
      }
      continue
    }
    if (c === "\\") {
      if (line[at + 1] === "\n") {
        at += 2
        continue
      }
      word += line[at + 1] ?? ""
      written = true
      at += 2
      continue
    }
    if (c === "'") {
      const close = line.indexOf("'", at + 1)
      const body = close < 0 ? line.slice(at + 1) : line.slice(at + 1, close)
      word += body
      written = true
      at = close < 0 ? n : close + 1
      continue
    }
    if (c === '"') {
      written = true
      at += 1
      while (at < n && line[at] !== '"') {
        const d = line[at]!
        if (d === "\\" && /["\\$`\n]/.test(line[at + 1] ?? "")) {
          if (line[at + 1] !== "\n") word += line[at + 1]
          at += 2
        } else if (d === "$" && line[at + 1] === "(") {
          const body = balanced(line, at + 1)
          dynamic = dynamicAll = true
          inner.push(...substitutions(line.slice(at, body.end)))
          word += line.slice(at, body.end)
          at = body.end
        } else if (d === "`") {
          const close = line.indexOf("`", at + 1)
          const end = close < 0 ? n : close + 1
          dynamic = dynamicAll = true
          inner.push(line.slice(at + 1, end - 1))
          word += line.slice(at, end)
          at = end
        } else if (d === "$" && /[A-Za-z_{@*#?$!0-9-]/.test(line[at + 1] ?? "")) {
          dynamic = dynamicAll = true
          word += d
          at += 1
        } else {
          word += d
          at += 1
        }
      }
      at += 1
      continue
    }
    if (c === "$" && line[at + 1] === "(") {
      const body = balanced(line, at + 1)
      dynamic = dynamicAll = true
      inner.push(...substitutions(line.slice(at, body.end)))
      word += line.slice(at, body.end)
      written = true
      at = body.end
      continue
    }
    if (c === "`") {
      const close = line.indexOf("`", at + 1)
      const end = close < 0 ? n : close + 1
      dynamic = dynamicAll = true
      inner.push(line.slice(at + 1, end - 1))
      word += line.slice(at, end)
      written = true
      at = end
      continue
    }
    if (c === "$" && /[A-Za-z_{@*#?$!0-9-]/.test(line[at + 1] ?? "")) {
      dynamic = dynamicAll = true
      word += c
      written = true
      at += 1
      continue
    }
    if (c === "#" && !written) {
      const end = line.indexOf("\n", at)
      at = end < 0 ? n : end
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord()
      at += 1
      continue
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // A subshell or group (`{` is a word only where a command may start, as `{ a; }`).
      if (c === "{" || c === "}") {
        if (!written && (line[at + 1] === " " || line[at + 1] === undefined)) {
          dynamicAll = dynamic = true
          at += 1
          continue
        }
        word += c
        written = true
        at += 1
        continue
      }
      dynamicAll = dynamic = true
      if (c === "(") {
        const body = balanced(line, at)
        inner.push(line.slice(at + 1, body.end - 1))
        endWord()
        word = ""
        written = false
        at = body.end
        continue
      }
      at += 1
      continue
    }
    if (c === "<" && line[at + 1] === "<" && line[at + 2] !== "<") {
      // A here-document: its delimiter, and the body after this line.
      let pos = at + 2
      const strip = line[pos] === "-"
      if (strip) pos += 1
      while (line[pos] === " " || line[pos] === "\t") pos += 1
      let delimiter = ""
      let quoted = false
      while (pos < n && !/[\s;&|()<>]/.test(line[pos]!)) {
        const d = line[pos]!
        if (d === "'" || d === '"') {
          quoted = true
          const close = line.indexOf(d, pos + 1)
          delimiter += line.slice(pos + 1, close < 0 ? n : close)
          pos = close < 0 ? n : close + 1
        } else if (d === "\\") {
          quoted = true
          delimiter += line[pos + 1] ?? ""
          pos += 2
        } else {
          delimiter += d
          pos += 1
        }
      }
      endWord()
      redirects.push(`<<${delimiter}`)
      heredocs.push({ delimiter, quoted, strip })
      at = pos
      continue
    }
    if (c === ">" || c === "<") {
      // A redirection, with the descriptor before it when that is digits alone.
      const digits = /^\d+$/.test(word) && written ? word : ""
      if (digits) {
        word = ""
        written = false
      } else endWord()
      let op = c
      at += 1
      if (line[at] === c || (c === ">" && (line[at] === "&" || line[at] === "|"))) {
        op += line[at]
        at += 1
      } else if (c === "<" && line[at] === "&") {
        op += "&"
        at += 1
      }
      while (line[at] === " " || line[at] === "\t") at += 1
      // Its target: one word, read as an ordinary one.
      let target = ""
      while (at < n && !/[\s;&|()<>]/.test(line[at]!)) {
        if (line[at] === "'" || line[at] === '"') {
          const close = line.indexOf(line[at]!, at + 1)
          target += line.slice(at + 1, close < 0 ? n : close)
          at = close < 0 ? n : close + 1
        } else if (line[at] === "$" || line[at] === "`") {
          dynamicAll = dynamic = true
          target += line[at]
          at += 1
        } else {
          target += line[at]
          at += 1
        }
      }
      redirects.push(`${digits}${op}${target}`)
      continue
    }
    const operator = operators.find((each) => line.startsWith(each, at))
    if (operator) {
      // `>&` and `&>` were taken above; a lone `&` ends a command that runs on its own.
      endCommand(at, operator === ";;" ? ";" : operator === "|&" ? "|" : operator)
      at += operator.length
      start = at
      continue
    }
    word += c
    written = true
    at += 1
  }
  endCommand(n, ";")
  return { commands, dynamic: dynamicAll, inner }
}

/** The index just past the parenthesis group that opens at `open`, quotes and nesting kept. */
const balanced = (line: string, open: number): { end: number } => {
  let depth = 0
  let at = open
  while (at < line.length) {
    const c = line[at]!
    if (c === "\\") at += 2
    else if (c === "'") {
      const close = line.indexOf("'", at + 1)
      at = close < 0 ? line.length : close + 1
    } else if (c === '"') {
      at += 1
      while (at < line.length && line[at] !== '"') at += line[at] === "\\" ? 2 : 1
      at += 1
    } else {
      if (c === "(") depth += 1
      if (c === ")") {
        depth -= 1
        if (depth === 0) return { end: at + 1 }
      }
      at += 1
    }
  }
  return { end: line.length }
}

/** The command lines inside `$(…)` and backticks in `text`, at any depth. */
const substitutions = (text: string): string[] => {
  const found: string[] = []
  let at = 0
  while (at < text.length) {
    if (text[at] === "$" && text[at + 1] === "(") {
      const { end } = balanced(text, at + 1)
      found.push(text.slice(at + 2, end - 1))
      at = end
    } else if (text[at] === "`") {
      const close = text.indexOf("`", at + 1)
      const end = close < 0 ? text.length : close
      found.push(text.slice(at + 1, end))
      at = end + 1
    } else at += 1
  }
  return found
}
