import type { Anchor } from "../src/atlas.ts"
import type { Anchors } from "./anchors.ts"

export const routerFile = "application/runner/src/router.ts"
export const runnerDir = "application/runner/src"

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
  const services = [...options.matchAll(/^\s+(\w+): (\w+)$/gm)].flatMap((match) => {
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
