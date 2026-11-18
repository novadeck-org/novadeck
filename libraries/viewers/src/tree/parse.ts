import { LineCounter, parseAllDocuments } from "yaml"

// Reading a data file into what the tree viewer shows: a JSON value, a JSONL file's
// records, or a YAML file's documents. Pure: the text in, the roots or where it failed out.

export type DataFormat = "json" | "jsonl" | "yaml"

/** The data format a file's name says, if it's one the tree reads. */
export const dataFormatOf = (path: string): DataFormat | undefined => {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  if (extension === "json") return "json"
  if (extension === "jsonl" || extension === "ndjson") return "jsonl"
  if (extension === "yaml" || extension === "yml") return "yaml"
  return undefined
}

/**
 * One thing at the tree's top: a value (the JSON file's, one JSONL record, one YAML
 * document), or a JSONL record that doesn't read, with its text and why. `label` names it
 * among others ("Line 12", "Document 2"); a file of one value has none. `line` is the line
 * it starts at in the file.
 */
export type DataRoot =
  | {
      readonly kind: "value"
      readonly label: string | null
      readonly line: number
      readonly value: unknown
    }
  | {
      readonly kind: "broken"
      readonly label: string
      readonly line: number
      readonly text: string
      readonly reason: string
    }

/** Where a text stopped reading, by line and column, both from 1. */
export type DataError = { readonly message: string; readonly line: number; readonly column: number }

export type Parsed =
  | { readonly ok: true; readonly roots: readonly DataRoot[] }
  | { readonly ok: false; readonly error: DataError }

export type ParseOptions = {
  /** The number of the text's first line in its file. */
  readonly firstLine?: number
  /** A line this long may have been cut short before it got here: a record that long that
   *  doesn't read says so. */
  readonly longest?: number
}

// The line and column an offset falls at, counting from `firstLine`.
const positionOf = (text: string, offset: number, firstLine: number): [number, number] => {
  let line = firstLine
  let start = 0
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) {
    line += 1
    start = at + 1
  }
  return [line, offset - start + 1]
}

/**
 * Where JSON stops reading, and why, for a text `JSON.parse` refused: the engine's own
 * message doesn't always say where. A small scanner of JSON's grammar, which only finds
 * the first place it breaks.
 */
export const jsonErrorAt = (text: string): { offset: number; message: string } => {
  let at = 0
  const fail = (message: string): never => {
    throw { offset: at, message }
  }
  const space = (): void => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at += 1
  }
  const found = (): string => (at >= text.length ? "the end" : JSON.stringify(text[at]))
  const expect = (char: string, what: string): void => {
    if (text[at] !== char) fail(`Expected ${what}, found ${found()}`)
    at += 1
  }
  const string = (): void => {
    at += 1
    for (;;) {
      if (at >= text.length) fail("A string doesn't end")
      const char = text[at]!
      if (char === '"') return void (at += 1)
      if (char < " ") fail("A string holds a control character")
      if (char === "\\") {
        const next = text[at + 1]
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
            at += 1
            fail("A \\u escape needs four hex digits")
          }
          at += 6
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) at += 2
        else {
          at += 1
          fail("A string holds an unknown escape")
        }
      } else at += 1
    }
  }
  const number = (): void => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))
    if (!match || match[0] === "-") fail(`Expected a value, found ${found()}`)
    at += match![0].length
  }
  const value = (): void => {
    space()
    const char = text[at]
    if (char === "{") {
      at += 1
      space()
      if (text[at] === "}") return void (at += 1)
      for (;;) {
        space()
        if (text[at] !== '"') fail(`Expected a key in quotes, found ${found()}`)
        string()
        space()
        expect(":", "':' after a key")
        value()
        space()
        if (text[at] === "}") return void (at += 1)
        expect(",", "',' or '}' after a value")
      }
    }
    if (char === "[") {
      at += 1
      space()
      if (text[at] === "]") return void (at += 1)
      for (;;) {
        value()
        space()
        if (text[at] === "]") return void (at += 1)
        expect(",", "',' or ']' after a value")
      }
    }
    if (char === '"') return string()
    for (const word of ["true", "false", "null"])
      if (text.startsWith(word, at)) return void (at += word.length)
    number()
  }
  try {
    value()
    space()
    if (at < text.length) fail(`Expected the end, found ${found()}`)
  } catch (error) {
    if (typeof error === "object" && error !== null && "offset" in error)
      return error as { offset: number; message: string }
    throw error
  }
  // It reads after all: the engine refused it for another reason, as too deep.
  return { offset: 0, message: "It doesn't read as JSON" }
}

const parseJson = (text: string, firstLine: number): Parsed => {
  try {
    return {
      ok: true,
      roots: [{ kind: "value", label: null, line: firstLine, value: JSON.parse(text) }],
    }
  } catch {
    const { offset, message } = jsonErrorAt(text)
    const [line, column] = positionOf(text, offset, firstLine)
    return { ok: false, error: { message, line, column } }
  }
}

// Each line a record, blank lines skipped; one that doesn't read is a broken record, never
// the whole file's failure, as a file read part way ends in one cut short.
const parseJsonl = (text: string, firstLine: number, longest?: number): Parsed => {
  const roots: DataRoot[] = []
  text.split(/\r?\n/).forEach((source, index) => {
    if (source.trim() === "") return
    const line = firstLine + index
    const label = `Line ${line}`
    try {
      roots.push({ kind: "value", label, line, value: JSON.parse(source) })
    } catch {
      const cut = longest !== undefined && source.length >= longest
      const failed = cut ? undefined : jsonErrorAt(source)
      const reason = failed
        ? `${failed.message}, at column ${failed.offset + 1}`
        : `Cut short at ${longest} characters`
      roots.push({ kind: "broken", label, line, text: source, reason })
    }
  })
  return { ok: true, roots }
}

// Every document, anchors and aliases resolved; the first error any has fails the file.
const parseYaml = (text: string, firstLine: number): Parsed => {
  const counter = new LineCounter()
  const where = (offset: number): { line: number; column: number } => {
    const { line, col } = counter.linePos(offset)
    return { line: line + firstLine - 1, column: col }
  }
  try {
    const parsed = parseAllDocuments(text, {
      lineCounter: counter,
      prettyErrors: false,
      // `<<: *base` merges, as Compose and CI files write it.
      merge: true,
    })
    // An empty stream has its own errors when it's no YAML at all.
    if ("empty" in parsed) {
      const [first] = parsed.errors
      if (first) return { ok: false, error: { message: first.message, ...where(first.pos[0]) } }
    }
    const documents = [...parsed]
    for (const document of documents) {
      const [first] = document.errors
      if (first) return { ok: false, error: { message: first.message, ...where(first.pos[0]) } }
    }
    const many = documents.length > 1
    return {
      ok: true,
      roots: documents.map((document, index) => ({
        kind: "value",
        label: many ? `Document ${index + 1}` : null,
        line: where(document.range[0]).line,
        value: document.toJS({ maxAliasCount: 1000 }),
      })),
    }
  } catch (error) {
    // Aliases past the count, which a text built to blow up would need.
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { message, line: firstLine, column: 1 } }
  }
}

/** Reads a data file's text as `format`. */
export const parseData = (text: string, format: DataFormat, options: ParseOptions = {}): Parsed => {
  const firstLine = options.firstLine ?? 1
  if (format === "json") return parseJson(text, firstLine)
  if (format === "jsonl") return parseJsonl(text, firstLine, options.longest)
  return parseYaml(text, firstLine)
}
