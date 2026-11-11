import { dirname, isAbsolute, join, resolve } from "node:path"

import {
  closureOf,
  fromRoot,
  manifestOf,
  packageFolderOf,
  packageFolders,
  packageOf,
  workspaceNames,
} from "./lookup.ts"
import { declaredReads, isRead } from "./platform.ts"
import { isProse, scopeAbove } from "./scopes.ts"

// The fence around what the package graph can't see: a package's code or tests reading a file
// by its path, past the package's own folder. CI runs a package's tests when it, or a package it
// depends on, changed (turbo's `--affected`), so a test that reads another package's files
// without depending on it, or reads prose or a narrowed folder outside every package (scopes.ts),
// is skipped when what it reads changes. This rule, in the lint plugin (fence.ts), works out
// the paths a file builds from its own place (`import.meta.dirname`, `import.meta.url`,
// `__dirname`, `process.cwd()`, which a test runs in its package's folder, through `join`,
// `resolve`, `dirname`, `fileURLToPath`, `new URL` and the
// variables that hold them) and refuses each one used that lands elsewhere. A path it can't
// follow to its end (`join(root, name)`) counts as all it could be. reach.test.ts proves it.

/** Where a path leads: an absolute path, and whether more follows that can't be read. */
export type Target = { readonly path: string; readonly exact: boolean }

/**
 * Why a package (`folder`, relative to `root`) may not read `target`, or `undefined` where it
 * may: inside itself, inside a package it depends on, inside a `node_modules`, under what it
 * declares it `reads`, or outside every package where a change runs everything.
 */
export const refusal = (
  root: string,
  folder: string,
  target: Target,
  reads: readonly string[] = [],
): string | undefined => {
  const path = fromRoot(root, target.path)
  const own = (inside: string) => path === inside || path.startsWith(`${inside}/`)
  if (own(folder)) return undefined
  if (path.split("/").includes("node_modules")) return undefined
  // Declared: CI counts the package affected by a change there (platform.ts).
  if (isRead(reads, path)) return undefined
  if (path === ".." || path.startsWith("../"))
    return `${path} is outside the repository, where no change can be seen`
  const reached = packageFolderOf(root, path)
  if (reached) {
    if (closureOf(root, folder).has(reached)) return undefined
    return `${reached} is another package, which ${folder} doesn't depend on: declare it as a dependency, or the path in its novadeck.reads, or move this where the files are`
  }
  const inside = path === "" ? "the repository" : path
  // A folder above packages, or a path whose end can't be read, could be anything below it.
  if (
    !target.exact ||
    path === "" ||
    packageFolders(root).some((each) => each.startsWith(`${path}/`))
  )
    return `${inside} could hold any package's files${target.exact ? "" : ", as the rest of the path can't be read"}: name the file, or declare the folder in novadeck.reads`
  if (isProse(path))
    return `${path} is prose outside every package, whose change runs no test but its readers': declare it in novadeck.reads`
  const scope = scopeAbove(root, path)
  if (scope)
    return `${path} is under ${scope.folder}, whose ci-scope.json says a change there reaches only the repository's tests: declare it in novadeck.reads`
  return undefined
}

// The minimum of the AST this reads: ESTree, as oxlint hands it to a plugin, with `parent`.
type Node = {
  readonly type: string
  readonly parent?: Node
  readonly name?: string
  readonly value?: unknown
  readonly computed?: boolean
  readonly object?: Node
  readonly property?: Node
  readonly meta?: Node
  readonly callee?: Node
  readonly arguments?: readonly Node[]
  readonly id?: Node
  readonly init?: Node | null
  readonly key?: Node
  readonly source?: Node | null
  readonly quasis?: readonly { readonly value: { readonly cooked: string | null } }[]
  readonly expressions?: readonly Node[]
}
type Context = {
  readonly filename: string
  readonly report: (problem: { readonly node: Node; readonly message: string }) => void
}

/** A path's value as it's built: where it leads, and whether it names a file or a URL's base. */
type Value = Target & { readonly url?: true }

const pathCalls = new Set(["join", "resolve", "normalize"])

const calleeName = (callee: Node | undefined): string | undefined =>
  callee?.type === "Identifier"
    ? callee.name
    : callee?.type === "MemberExpression" && !callee.computed
      ? callee.property?.name
      : undefined

/** Folds string pieces onto a path, stopping at the first piece it can't read. */
const append = (start: Value, pieces: readonly (string | undefined)[]): Value => {
  let path = start.path
  for (const piece of pieces) {
    if (piece === undefined) return { path, exact: false }
    path = isAbsolute(piece) ? piece : join(path, piece)
  }
  return { path, exact: start.exact }
}

/** A string's text, a template's up to its first `${…}`, a string constant's, or `undefined`. */
const textOf = (
  node: Node | undefined,
  strings: ReadonlyMap<string, string> = new Map(),
): { text: string; whole: boolean } | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string")
    return { text: node.value, whole: true }
  if (node?.type === "TemplateLiteral" && node.quasis?.[0])
    return { text: node.quasis[0].value.cooked ?? "", whole: (node.expressions ?? []).length === 0 }
  if (node?.type === "Identifier" && node.name !== undefined && strings.has(node.name))
    return { text: strings.get(node.name)!, whole: true }
  return undefined
}

export const reach = {
  meta: {
    type: "problem",
    docs: { description: "Keeps a package from reading files the package graph can't see." },
  },
  create: (context: Context) => {
    const file = context.filename
    const found = packageOf(file)
    if (!found) return {}
    const { root, folder } = found
    // Reads that can't be read count as none: the rule then asks for them.
    const reads = declaredReads(manifestOf(root, folder)) ?? []
    const here = dirname(file)
    const values = new Map<string, Value>()
    // The file's string constants (`const sheet = "frontend/ui/src/styles.css"`), for the paths
    // built from them.
    const strings = new Map<string, string>()

    const evaluate = (node: Node | undefined): Value | undefined => {
      if (!node) return undefined
      if (node.type === "MemberExpression" && !node.computed) {
        const property = node.property?.name
        if (node.object?.type === "MetaProperty") {
          if (property === "dirname") return { path: here, exact: true }
          if (property === "filename") return { path: file, exact: true }
          if (property === "url") return { path: file, exact: true, url: true }
          return undefined
        }
        // A URL's path, as `new URL(…).pathname` gives it.
        if (property === "pathname" || property === "href") {
          const value = evaluate(node.object)
          return value && { path: value.path, exact: value.exact }
        }
        return undefined
      }
      if (node.type === "Identifier") {
        if (node.name === "__dirname") return { path: here, exact: true }
        if (node.name === "__filename") return { path: file, exact: true }
        return node.name === undefined ? undefined : values.get(node.name)
      }
      if (node.type === "CallExpression") {
        const name = calleeName(node.callee)
        // A package's tests run in its own folder, as `pnpm test` starts them there.
        if (
          name === "cwd" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.object?.type === "Identifier" &&
          node.callee.object.name === "process"
        )
          return { path: join(root, folder), exact: true }
        const [first, ...rest] = node.arguments ?? []
        if (name === "dirname" || name === "fileURLToPath") {
          const value = evaluate(first)
          if (!value) return undefined
          return name === "dirname" ? { path: dirname(value.path), exact: value.exact } : value
        }
        if (name && pathCalls.has(name)) {
          const start = evaluate(first)
          if (!start) return undefined
          return append(
            start,
            rest.map((each) => {
              const text = textOf(each, strings)
              return text?.whole ? text.text : undefined
            }),
          )
        }
        return undefined
      }
      if (node.type === "NewExpression" && calleeName(node.callee) === "URL") {
        const [relativePath, base] = node.arguments ?? []
        const from = evaluate(base)
        const text = textOf(relativePath, strings)
        if (!from || !text) return undefined
        // A URL resolves against its base's folder, or the base itself where it names one.
        const against = from.url && !from.path.endsWith("/") ? dirname(from.path) : from.path
        const path = resolve(against, text.text)
        return { path, exact: from.exact && text.whole, url: true }
      }
      if (node.type === "TemplateLiteral") {
        // `${root}/frontend/x`: a path variable, then text.
        const [first] = node.expressions ?? []
        if (!first || node.quasis?.[0]?.value.cooked !== "") return undefined
        const start = evaluate(first)
        if (!start) return undefined
        const after = node.quasis[1]?.value.cooked ?? ""
        const whole = (node.expressions ?? []).length === 1
        return append(start, [after.replace(/^\//, ""), ...(whole ? [] : [undefined])])
      }
      return undefined
    }

    /** Whether a node only feeds a bigger path, or a variable, which is checked where it's used. */
    const feeds = (node: Node): boolean => {
      const parent = node.parent
      if (!parent) return false
      if (parent.type === "VariableDeclarator") return parent.init === node || parent.id === node
      if (parent.type === "CallExpression") {
        const name = calleeName(parent.callee)
        return (
          (parent.arguments ?? []).includes(node) &&
          (name === "dirname" || name === "fileURLToPath" || (!!name && pathCalls.has(name))) &&
          evaluate(parent) !== undefined
        )
      }
      if (parent.type === "NewExpression") return evaluate(parent) !== undefined
      if (parent.type === "TemplateLiteral") return evaluate(parent) !== undefined
      if (parent.type === "MemberExpression")
        return parent.object === node && evaluate(parent) !== undefined
      return false
    }

    const check = (node: Node): void => {
      if (feeds(node)) return
      const target = evaluate(node)
      if (!target) return
      const why = refusal(root, folder, target, reads)
      if (why)
        context.report({
          node,
          message: `${folder} reads by path what CI can't see it read: ${why}.`,
        })
    }

    // A workspace package imported by name must be declared: pnpm refuses an undeclared one, but
    // for what the root itself depends on (the sandbox), which resolves from every package, and
    // which the graph then can't see.
    const declared = new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
        (kind) => Object.keys((manifestOf(root, folder) as Record<string, object>)[kind] ?? {}),
      ),
    )
    const own = String(manifestOf(root, folder).name)
    const undeclared = (node: Node, source: string): void => {
      const [scope = "", name = ""] = source.split("/")
      const bare = scope.startsWith("@") ? `${scope}/${name}` : scope
      if (bare === own || declared.has(bare) || !workspaceNames(root).has(bare)) return
      context.report({
        node,
        message: `${folder} imports ${bare}, a workspace package it doesn't declare, which resolves only as the root's own and which CI can't see: declare it in its package.json.`,
      })
    }

    // A relative import out of the package is a read by path too, and one by name is checked
    // for its declaration.
    const imported = (node: Node): void => {
      const text = textOf(node.source ?? undefined)
      if (!text?.whole) return
      if (!text.text.startsWith(".")) return undeclared(node, text.text)
      const why = refusal(root, folder, { path: resolve(here, text.text), exact: true }, reads)
      if (why)
        context.report({
          node,
          message: `${folder} imports by path what CI can't see it import: ${why}.`,
        })
    }

    return {
      VariableDeclarator: (node: Node) => {
        if (node.id?.type !== "Identifier" || !node.id.name) return
        const text = textOf(node.init ?? undefined)
        if (text?.whole) strings.set(node.id.name, text.text)
        const value = evaluate(node.init ?? undefined)
        if (value) values.set(node.id.name, value)
      },
      Identifier: (node: Node) => {
        const parent = node.parent
        // Names that aren't a reference: a key, a property, a declaration.
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
          return
        if (parent?.type === "Property" && parent.key === node && parent.value !== node) return
        if (node.name && values.has(node.name)) check(node)
      },
      CallExpression: check,
      NewExpression: check,
      MemberExpression: check,
      TemplateLiteral: check,
      ImportDeclaration: imported,
      ExportAllDeclaration: imported,
      ExportNamedDeclaration: imported,
      ImportExpression: imported,
    }
  },
}
