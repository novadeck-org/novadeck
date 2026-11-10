import { manifestOf, packageOf } from "./lookup.ts"
import { platformOf, systemImport, systemProperty } from "./platform.ts"
import { reach } from "./reach.ts"

// The lint plugin of the workspace's own rules (`.oxlintrc.json`'s `jsPlugins`): `platform`,
// here, and `reach` (reach.ts), which keeps a package from reading what the graph can't see.
//
// The fence around `neutral` packages, as an oxlint plugin (`.oxlintrc.json`'s `jsPlugins`):
// in a package that declares itself `neutral` (platform.ts), it refuses what would make it
// `system`, in its code and its tests alike. It reads each file's package from its
// package.json, so the fence follows the declarations and has no list of its own to keep.
// A rule of its own, not `no-restricted-imports`: oxlint takes that rule's options from the
// last override that matches a file, and the libraries' and the browser code's fences have
// them already. fence.test.ts lints probe files with the real config to prove it.

// The minimum of the AST this reads: ESTree, as oxlint hands it to a plugin.
type Literal = { readonly type: "Literal"; readonly value: unknown }
type Name = { readonly type: "Identifier"; readonly name: string } | Literal
type Specifier = {
  readonly type: string
  readonly importKind?: string
  readonly imported?: Name
}
type Node = {
  readonly type: string
  readonly importKind?: string
  readonly exportKind?: string
  readonly source?: Literal | { readonly type: string } | null
  readonly specifiers?: readonly Specifier[]
  readonly callee?: Name | { readonly type: string }
  readonly arguments?: readonly { readonly type: string; readonly value?: unknown }[]
  readonly object?: Name | { readonly type: string }
  readonly property?: Name | { readonly type: string }
  readonly computed?: boolean
}
type Context = {
  readonly filename: string
  readonly report: (problem: { readonly node: Node; readonly message: string }) => void
}

const neutral = new Map<string, boolean>()
/** The neutral package a file is in, by its folder, or `undefined` where it is in none. */
const neutralPackageOf = (file: string): string | undefined => {
  const found = packageOf(file)
  if (!found) return undefined
  const key = `${found.root}/${found.folder}`
  if (!neutral.has(key))
    neutral.set(key, platformOf(manifestOf(found.root, found.folder)) === "neutral")
  return neutral.get(key) ? found.folder : undefined
}

const nameOf = (name: Name | undefined): string | undefined =>
  name?.type === "Identifier" ? name.name : typeof name?.value === "string" ? name.value : undefined

const sourceOf = (node: Node): string | undefined =>
  node.source?.type === "Literal" && typeof (node.source as Literal).value === "string"
    ? ((node.source as Literal).value as string)
    : undefined

const platform = {
  meta: {
    type: "problem",
    docs: { description: "Keeps a neutral package off what would make it system." },
  },
  create: (context: Context) => {
    const folder = neutralPackageOf(context.filename)
    if (!folder) return {}
    const refuse = (node: Node, why: string): void =>
      context.report({
        node,
        message: `${why}, and ${folder} declares itself neutral: declare it "system" in its package.json, or keep this out of it.`,
      })
    const check = (node: Node, source: string | undefined, names?: readonly string[]): void => {
      const why = source === undefined ? undefined : systemImport(source, names)
      if (why) refuse(node, why)
    }
    return {
      ImportDeclaration: (node: Node) => {
        if (node.importKind === "type") return
        const specifiers = node.specifiers ?? []
        // `import { type A, type B } from …` is erased whole; a bare `import "…"` runs it.
        if (specifiers.length > 0 && specifiers.every((each) => each.importKind === "type")) return
        const named = specifiers.every((each) => each.type === "ImportSpecifier")
        check(
          node,
          sourceOf(node),
          named && specifiers.length > 0
            ? specifiers
                .filter((each) => each.importKind !== "type")
                .map((each) => nameOf(each.imported) ?? "")
            : undefined,
        )
      },
      ExportAllDeclaration: (node: Node) => {
        if (node.exportKind !== "type") check(node, sourceOf(node))
      },
      ExportNamedDeclaration: (node: Node) => {
        if (node.exportKind !== "type") check(node, sourceOf(node))
      },
      ImportExpression: (node: Node) => check(node, sourceOf(node)),
      // `require("…")`, as a CommonJS file or `createRequire` has it.
      CallExpression: (node: Node) => {
        const [first] = node.arguments ?? []
        if (nameOf(node.callee as Name) !== "require" || first?.type !== "Literal") return
        if (typeof first.value === "string") check(node, first.value)
      },
      MemberExpression: (node: Node) => {
        if (nameOf(node.object as Name) !== "process" || node.computed) return
        const property = nameOf(node.property as Name)
        const why = property === undefined ? undefined : systemProperty(property)
        if (why) refuse(node, why)
      },
    }
  },
}

export default { meta: { name: "novadeck" }, rules: { platform, reach } }
