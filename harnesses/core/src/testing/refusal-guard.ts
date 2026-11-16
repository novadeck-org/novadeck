import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Where a refusal's code is written, and the shape every code takes: `<dialog>.<step>.<n>`. */
const call = /\brefuse\(([^)]*)\)/g
const shape = /^"[a-z-]+\.[A-Za-z]+\.\d+"$/
/** A line that defines a function, and its name: `const keys = (`, `keys: (answer) =>`, `function keysFor(`. */
const definition =
  /^\s*(?:export\s+)?(?:const|let|function)\s+(\w+)|^\s*(?:readonly\s+)?(\w+)\s*:\s*(?:async\s*)?\(|^\s*(\w+)\s*\([^)]*\)\s*(?::[^=]*)?\{\s*$/

/**
 * What an adapter's sources do against the refusal rules (see `refuse` in dialogs.ts):
 * every `refuse(...)` takes a static string literal of the shape above, no code stands
 * twice in a harness, and a bare `return undefined` stands only inside what answers a
 * dialog (`keys`, a prompt, an answer's steps), where a refusal is the driver's to log, not
 * a read's. Empty when the folder's `*-dialog.ts` and `dialog-screen.ts` files keep to them.
 */
export const refusalProblems = (folder: string): string[] => {
  const problems: string[] = []
  const seen = new Map<string, string>()
  const files = readdirSync(folder).filter(
    (name) => /(?:^|-)dialog\.ts$|^dialog-screen\.ts$/.test(name) && !name.includes(".test"),
  )
  for (const name of files) {
    const lines = readFileSync(join(folder, name), "utf8").split("\n")
    lines.forEach((line, at) => {
      const where = `${name}:${at + 1}`
      for (const match of line.matchAll(call)) {
        const code = match[1]!.trim()
        if (!shape.test(code)) problems.push(`${where}: refuse takes a static code, not ${code}`)
        else if (seen.has(code)) problems.push(`${where}: ${code} is also at ${seen.get(code)}`)
        else seen.set(code, where)
      }
      // A ternary that gives undefined goes unchecked: most compute a value, not a refusal.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || !/\breturn undefined\b/.test(line)) return
      // The enclosing lines, nearest first: each indented less than the one before.
      let indent = line.length - line.trimStart().length
      let answering = false
      // A top-level signature that goes on over several lines ends in a `)` row: its name is above.
      let signature = false
      for (let up = at - 1; up >= 0 && (indent > 0 || signature); up -= 1) {
        const above = lines[up]!
        const deeper = above.length - above.trimStart().length
        if (above.trim() === "" || (deeper >= indent && !signature)) continue
        if (signature && (deeper > 0 || above.startsWith(")"))) continue
        indent = deeper
        signature = deeper === 0 && above.startsWith(")")
        // Only what defines a function names it: an `if` that reads `facts.answered` doesn't
        // make the rejection under it an answer's.
        const named = definition.exec(above)?.slice(1).find(Boolean)
        if (named && /^(?:keys|prompt|answers?|answered)|Keys$/i.test(named)) answering = true
      }
      if (!answering)
        problems.push(`${where}: a read's refusal returns refuse("<code>"), not undefined`)
    })
  }
  return problems
}
