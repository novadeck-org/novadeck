import type { SqlVerb, Statement, Touch } from "../../src/runner-lens.ts"

// The SQL in the runner's source: which strings are statements, and what they do to which table.

// Every string and template literal in `code` that reads as a SQL statement, with its
// offset. Interpolations become `?`; comments are skipped.
export const sqlIn = (code: string): { sql: string; at: number }[] => {
  const found: { sql: string; at: number }[] = []
  const template = (from: number): { text: string; end: number } => {
    let text = ""
    let i = from + 1
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") {
        text += code[i + 1] ?? ""
        i += 2
      } else if (code[i] === "$" && code[i + 1] === "{") {
        let depth = 1
        i += 2
        while (i < code.length && depth > 0) {
          if (code[i] === "{") depth += 1
          else if (code[i] === "}") depth -= 1
          else if (code[i] === "`") i = template(i).end
          i += 1
        }
        text += "?"
      } else text += code[i++]
    }
    return { text, end: i }
  }
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === "/" && code[i + 1] === "/")
      i = code.indexOf("\n", i) === -1 ? code.length : code.indexOf("\n", i)
    else if (ch === "/" && code[i + 1] === "*") i = code.indexOf("*/", i) + 1
    else if (ch === "`") {
      const { text, end } = template(i)
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i.test(text))
        found.push({ sql: text.replace(/\s+/g, " ").trim(), at: i })
      i = end
    } else if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1
      const text = code.slice(i + 1, j)
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text))
        found.push({ sql: text.replace(/\s+/g, " ").trim(), at: i })
      i = j
    }
  }
  return found
}

// The tables a statement touches: its subject by its leading keyword, every other
// `FROM`/`JOIN` as a read.
export const touchesOf = (sql: string, tables: Set<string>): Touch[] => {
  const kind = sql.trim().split(/\s/)[0]!.toLowerCase()
  const subject =
    kind === "insert" || kind === "replace"
      ? /\bINTO\s+(\w+)/i.exec(sql)
      : kind === "update"
        ? /^\s*UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i.exec(sql)
        : kind === "delete"
          ? /\bDELETE\s+FROM\s+(\w+)/i.exec(sql)
          : null
  const verb: SqlVerb =
    kind === "delete" ? "delete" : kind === "select" || kind === "with" ? "read" : "write"
  const touches: Touch[] = []
  const add = (table: string | undefined, as: SqlVerb): void => {
    if (table && tables.has(table) && !touches.some((t) => t.table === table && t.verb === as))
      touches.push({ table, verb: as })
  }
  add(subject?.[1], verb)
  // A write that returns the row it wrote reads that table too.
  if (subject && /\bRETURNING\b/i.test(sql)) add(subject[1], "read")
  const rest = subject ? sql.replace(subject[0], " ") : sql
  for (const match of rest.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) add(match[1], "read")
  return touches
}

export const statementKind = (sql: string): Statement["kind"] => {
  const word = sql.trim().split(/\s/)[0]!.toLowerCase()
  return word === "insert" || word === "replace"
    ? "insert"
    : word === "update"
      ? "update"
      : word === "delete"
        ? "delete"
        : "select"
}
