import type { Anchor } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

export const routerFile = "backend/runner/src/router.ts"
export const runnerDir = "backend/runner/src"

// A service the router hands its calls to: `terminals: Terminals` in the options of
// `createRouter`, with the file its type is imported from.
export type Service = { field: string; type: string; file: string }

export const servicesOf = (anchors: Anchors, router: string): Service[] => {
  const imports = new Map(
    [...router.matchAll(/import type \{ (\w+) \} from "\.\/([^"]+)\.(?:js|ts)"/g)].map((match) => [
      match[1]!,
      `${runnerDir}/${match[2]}.ts`,
    ]),
  )
  const at = router.indexOf("createRouter")
  if (at === -1) {
    anchors.report("router services", routerFile, 'expected "createRouter"')
    return []
  }
  // Only the options type: from the `{` after `options:` to the brace that closes it,
  // counted by depth, so a function-typed option with an object parameter can't end it early.
  const open = router.indexOf("{", router.indexOf("options:", at))
  let end = -1
  if (open !== -1)
    for (let i = open, depth = 0; i < router.length; i += 1) {
      if (router[i] === "{") depth += 1
      else if (router[i] === "}" && --depth === 0) {
        end = i
        break
      }
    }
  if (end === -1)
    anchors.report("router services", routerFile, "expected createRouter's `options: { … }` type")
  const options = end === -1 ? "" : router.slice(open, end)
  const services = [...options.matchAll(/^\s+(\w+)\??: (\w+)$/gm)].flatMap((match) => {
    const file = imports.get(match[2]!)
    // An option typed by a class or type the scan can't find the import of has lost its
    // service, and every handler that calls it would quietly fall back to the router.
    if (!file && /^[A-Z]/.test(match[2]!))
      anchors.report(
        "router services",
        routerFile,
        `no import found for ${match[1]}: ${match[2]} in createRouter's options`,
      )
    if (file && anchors.read(file) === null)
      anchors.report(
        "router services",
        file,
        `${match[1]}: ${match[2]} is imported from a missing file`,
      )
    return file ? [{ field: match[1]!, type: match[2]!, file }] : []
  })
  if (services.length === 0)
    anchors.report(
      "router services",
      routerFile,
      'no service found: expected `import type { X } from "./dir/file.js"` and `field: X` in createRouter\'s options',
    )
  return services
}

// The router's code for a procedure's handler, from `api.<id>.handler(` to the next one,
// and where it starts; null when the router has none.
export const handlerBody = (router: string, id: string): { start: number; body: string } | null => {
  const start = router.indexOf(`api.${id}.handler(`)
  if (start === -1) return null
  const skip = start + id.length + 20
  const next = router.slice(skip).search(/\.handler\(/)
  return { start, body: router.slice(start, next === -1 ? undefined : skip + next) }
}

// The line where `service` defines `method`: a method, or an arrow property or object
// member whose line opens a body (ends in `{` or `(`), not a type field, a value or a call. The service's own file first, then its
// folder, the manager or service file ahead of the rest.
export const findDefinition = (
  anchors: Anchors,
  runnerFiles: string[],
  service: Service,
  method: string,
): Anchor | null => {
  const dir = service.file.slice(0, service.file.lastIndexOf("/"))
  const pattern = new RegExp(
    `^ {2,6}(?:(?:async|get|static|private|public|protected|readonly)\\s+)*\\*?${method}\\s*(?:<[^>]*>)?\\(|^ {2,6}(?:(?:private|public|protected|readonly)\\s+)*${method}\\s*[=:]\\s*(?:async\\s*)?[(<]`,
  )
  const siblings = runnerFiles
    .filter((file) => file.startsWith(`${dir}/`))
    .toSorted((a, b) => Number(/manager|service/.test(b)) - Number(/manager|service/.test(a)))
  for (const file of new Set([service.file, ...siblings])) {
    const lines = anchors.read(file)?.split("\n") ?? []
    // A definition opens a body (`{` or `(` ends the line) or holds it on one line.
    const index = lines.findIndex(
      (text) => pattern.test(text) && /[{(]$|\)[^{}]*\{.*\}$/.test(text.trimEnd()),
    )
    if (index !== -1) return { file, line: index + 1 }
  }
  return null
}

// The functions the router imports by value from the runner's own files: `savePlan` from
// `./companions/content.js` is `backend/runner/src/companions/content.ts`.
export const functionsOf = (router: string): Map<string, string> =>
  new Map(
    [...router.matchAll(/^import \{([^}]+)\} from "\.\/([^"]+)\.(?:js|ts)"/gm)].flatMap((match) =>
      match[1]!
        .split(",")
        .map((name) => name.trim())
        .filter((name) => /^\w+$/.test(name))
        .map((name) => [name, `${runnerDir}/${match[2]}.ts`] as const),
    ),
  )

// A call in a handler's body: `service.method(` (`service` set) or an imported `fn(`.
export type HandlerCall = { service: string | null; name: string; at: number }

// The offset of the bracket that closes the one at `open`.
const closing = (text: string, open: number): number => {
  for (let i = open, depth = 0; i < text.length; i++) {
    if ("([{".includes(text[i]!)) depth += 1
    else if (")]}".includes(text[i]!) && --depth === 0) return i
  }
  return text.length
}

// Where an arrow function's body is, from just past its `=>`: a block, or an expression
// up to the `,` or bracket that ends it.
const arrowBody = (text: string, from: number): [number, number] => {
  let start = from
  while (/\s/.test(text[start] ?? "")) start += 1
  if (text[start] === "{") return [start, closing(text, start)]
  for (let i = start, depth = 0; i < text.length; i++) {
    if ("([{".includes(text[i]!)) depth += 1
    else if (")]}".includes(text[i]!) && --depth < 0) return [start, i]
    else if (text[i] === "," && depth === 0) return [start, i]
  }
  return [start, text.length]
}

const inside = (ranges: [number, number][], at: number) =>
  ranges.some(([from, to]) => at >= from && at < to)

// The calls in a handler's body (from `api.<id>.handler(`), the likeliest to do the
// procedure's work first. A call named like the procedure comes first; then one whose
// value the handler returns; a store read, a call in a callback passed on (`place: (id) =>
// terminals.place(id)`) and above all a guard in an `if (` or `while (` condition come
// last. A ternary's or an `&&`'s condition is not told apart. Ties keep source order.
export const rankCalls = (
  body: string,
  procedure: string,
  functions: ReadonlySet<string>,
): HandlerCall[] => {
  const name = procedure.split(".").at(-1)
  const guards = [...body.matchAll(/\b(?:if|while)\s*\(/g)].map((match): [number, number] => {
    const open = match.index + match[0].length - 1
    return [open, closing(body, open)]
  })
  // Arrows passed as an argument or a property's value, but not the handler's own (a
  // handler may be an `async function*`, with no arrow of its own).
  const callbacks = [...body.matchAll(/=>/g)].flatMap((match): [number, number][] => {
    let before = body.slice(0, match.index).trimEnd()
    before = before.endsWith(")")
      ? body.slice(0, before.lastIndexOf("(", before.length - 1)).trimEnd()
      : before.replace(/\w+$/, "").trimEnd()
    before = before.replace(/\basync$/, "").trimEnd()
    if (before.endsWith(".handler(")) return []
    return /[(,:]$/.test(before) ? [arrowBody(body, match.index + 2)] : []
  })
  // Whether the handler returns the call's value: on a `return` line, or named by a const
  // the handler returns whole or spreads. A callback's own `return` is not the handler's.
  const returned = (at: number) => {
    if (inside(callbacks, at)) return false
    const line = body.slice(body.lastIndexOf("\n", at) + 1, at).trimStart()
    if (line.startsWith("return ")) return true
    const constant = /^const (\w+) = (?:await )?$/.exec(line)?.[1]
    return (
      constant !== undefined &&
      new RegExp(`\\breturn ${constant}\\s*(?:$|[;})])|\\.\\.\\.${constant}\\b`, "m").test(body)
    )
  }
  const calls: HandlerCall[] = [
    // Not `<name>.handler(` itself, which opens the body.
    ...[...body.matchAll(/\b(\w+)\.(?!handler\()(\w+)\(/g)].map((match) => ({
      service: match[1]!,
      name: match[2]!,
      at: match.index,
    })),
    ...[...body.matchAll(/(?<![\w.]|new\s+)(\w+)\(/g)]
      .filter((match) => functions.has(match[1]!))
      .map((match) => ({ service: null, name: match[1]!, at: match.index })),
  ].toSorted((a, b) => a.at - b.at)
  const rank = (call: HandlerCall): number =>
    (call.name === name ? 0 : 10) +
    (call.service === "store" ? 1 : 0) +
    (inside(callbacks, call.at) ? 3 : 0) +
    (inside(guards, call.at) ? 5 : 0) -
    (returned(call.at) ? 4 : 0)
  return calls.toSorted((a, b) => rank(a) - rank(b))
}

// The line where a runner file defines an exported function.
export const findFunction = (anchors: Anchors, file: string, name: string): Anchor | null => {
  const lines = anchors.read(file)?.split("\n") ?? []
  const index = lines.findIndex((text) =>
    new RegExp(`^export (?:async )?(?:function\\*? ${name}\\b|const ${name}\\b)`).test(text),
  )
  return index === -1 ? null : { file, line: index + 1 }
}
