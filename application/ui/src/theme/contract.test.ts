// @vitest-environment node -- esbuild, which compiles the scripts, needs Node's own TextEncoder

// The theming contract in docs/theming.md, checked against the source.
//
// Themes: every theme in `themes.ts` has a file in `theme/`, imported into
// `layer(themes)`, whose selectors all start with its own scope: `:root[data-theme="<id>"]`,
// or for Graphite, the default, `:root:where(:not([data-theme]), [data-theme="graphite"])`.
// Themes that share a file may also start one with their shared scope,
// `:root:is([data-theme="<id>"], …)`. The file defines every required foundation token
// (`tokens.ts`, which the doc's table matches) for each scheme the manifest lists, on the
// theme's scope or the shared one. The first scheme lives on the scope, each other one on
// the scope plus `[data-scheme="<scheme>"]`.
//
// Rules: (a) to (d) below hold for every file. Rule (c) has a short list of
// exceptions, each with its reason, which the guide's "Exceptions" section repeats; an
// exception the source no longer needs fails the check until it leaves both lists. A
// failure names the rule, the file and what breaks it, and says how to fix it.
//
// (a) TSX arranges, recipes draw. Every class string in the UI's .ts and .tsx
//     source is split into class tokens; a token whose utility (after its variants,
//     `!` and `-`) begins with a Tailwind utility root must match `layoutUtilities`.
//     Allowed: display, flex and grid, gap, margin, padding, position and inset,
//     z-index, order, overflow, visibility, sizes, transforms, pointer and scroll
//     behaviour, `opacity-0` and `opacity-100`, and type that sets size and flow: text
//     sizes (a step of the type scale such as `text-body`, or `text-[11px]`), alignment
//     (`text-center`), wrapping and truncation, line height (`leading-*`) and weight
//     (`font-medium`). Everything else is a look: colours and backgrounds
//     (`text-muted`, `bg-*`), every `border*` (width, sides and colour), `rounded*`,
//     `shadow*`, `ring*`, `outline*`, opacity between 0 and 1, fill, stroke, filters
//     and backdrops, font family (`font-mono`), letter spacing, text transform and
//     decoration, and motion (`transition*`, `duration-*`, `ease-*`, `animate-*`). An
//     arbitrary property (`[overflow-wrap:anywhere]`) follows the same split by its
//     property name. Class strings are found in each script's syntax tree; see
//     `classStrings`. `@apply` in a stylesheet follows the same split.
// (b) No colour literals in CSS outside theme files: hex, colour functions (`rgb()`,
//     `hsl()`, `oklch()`, …), named colours, Tailwind palette colours in `@apply`, and
//     system colours, in any case, outside `accessibility.css`. `transparent`, `currentColor` and
//     `color-mix()` over tokens are fine.
// (c) No `!important` (or an `@apply` important modifier, after any variants), except
//     the declarations `importantExceptions` lists and says why: it turns the layer
//     order around.
// (d) Every stylesheet is layered. Each `@import` in `styles.css` carries `layer(…)`,
//     except Tailwind itself and `theme/contract.css`, which hold only what Tailwind
//     layers. Any other CSS file is imported from `styles.css` into a layer or wraps
//     everything in `@layer`. CSS imported from .ts or .tsx counts as unlayered unless
//     it wraps itself; a package's CSS imported from .ts or .tsx is charged to the
//     importing file.

import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { parseAst, transformWithEsbuild } from "vite"

import { describe, expect, it } from "../test"
import { themes, type ThemeEntry } from "./themes"
import { requiredTokens } from "./tokens"

const src = join(process.cwd(), "src")
const doc = readFileSync(join(process.cwd(), "..", "..", "docs", "theming.md"), "utf8")
const all = (readdirSync(src, { recursive: true }) as string[]).map((file) =>
  file.split("\\").join("/"),
)
const read = (file: string): string => readFileSync(join(src, file), "utf8")
const stylesheets = all.filter((file) => file.endsWith(".css"))
const fileOf = (theme: ThemeEntry): string => `theme/${theme.file ?? theme.id}.css`
const themeFile = (file: string): boolean => themes.some((theme) => file === fileOf(theme))
// The themes drawn by the file that draws this one, itself included.
const sharing = (theme: ThemeEntry): ThemeEntry[] =>
  themes.filter((other) => fileOf(other) === fileOf(theme))
// What a theme's selectors start with. The default theme applies when no theme is set,
// so its scope also matches that; the others match their own `data-theme` only.
const scopeOf = (id: string): string =>
  id === themes[0].id
    ? ':root:where(:not([data-theme]), [data-theme="graphite"])'
    : `:root[data-theme="${id}"]`
// What rules for every theme in a shared file start with; none for a file of one theme.
const sharedScopeOf = (theme: ThemeEntry): string | undefined => {
  const together = sharing(theme)
  return together.length < 2
    ? undefined
    : `:root:is(${together.map((other) => `[data-theme="${other.id}"]`).join(", ")})`
}
const scripts = all.filter(
  (file) =>
    /\.tsx?$/.test(file) &&
    !/\.(test|spec)\.tsx?$/.test(file) &&
    !/^(specs|test|theme)\//.test(file) &&
    file !== "test.ts",
)

// ---- A small CSS reader: comments out, then blocks and statements by nesting.

type CssNode = { readonly prelude: string; readonly body?: string }

const uncomment = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "")

const cssNodes = (css: string): CssNode[] => {
  const found: CssNode[] = []
  let start = 0
  let open = 0
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < css.length; index++) {
    const char = css[index]
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "{") {
      if (depth === 0) open = index
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) {
        found.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, index) })
        start = index + 1
      }
    } else if (char === ";" && depth === 0) {
      found.push({ prelude: css.slice(start, index).trim() })
      start = index + 1
    }
  }
  const rest = css.slice(start).trim()
  return rest ? [...found, { prelude: rest }] : found
}

// A selector list's selectors: split at its own commas, not those inside `:is()` or
// another function.
const selectorList = (prelude: string): string[] => {
  const found: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < prelude.length; index++) {
    const char = prelude[index]
    if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    else if (char === "," && depth === 0) {
      found.push(prelude.slice(start, index).trim())
      start = index + 1
    }
  }
  return [...found, prelude.slice(start).trim()]
}

// Every statement inside any block, with the prelude of the block that holds it.
const statements = (css: string): { readonly block: string; readonly text: string }[] =>
  cssNodes(css).flatMap((node) =>
    node.body === undefined
      ? []
      : cssNodes(node.body).flatMap((inner) =>
          inner.body === undefined
            ? [{ block: node.prelude, text: inner.prelude }]
            : statements(`${inner.prelude}{${inner.body}}`),
        ),
  )

const declarations = (body: string): Map<string, string> =>
  new Map(
    cssNodes(body).flatMap((node) => {
      const colon = node.prelude.indexOf(":")
      return node.body === undefined && colon > 0
        ? [[node.prelude.slice(0, colon).trim(), node.prelude.slice(colon + 1).trim()] as const]
        : []
    }),
  )

// ---- Reporting: what breaks a rule, by file, with how to fix it.

type Rule = { readonly broken: string; readonly fix: string }

const report = (rule: Rule, found: Map<string, string[]>): string[] =>
  [...found].map(([file, problems]) => {
    const shown = problems.slice(0, 8).join(", ")
    const more = problems.length > 8 ? ` (${problems.length - 8} more)` : ""
    return `${file} ${rule.broken}: ${shown}${more}. ${rule.fix}`
  })

const byFile = (entries: readonly (readonly [string, string[]])[]): Map<string, string[]> =>
  new Map(entries.filter(([, problems]) => problems.length > 0))

// Expands `--color-{a,b}-fg` into `--color-a-fg` and `--color-b-fg`.
const expand = (token: string): string[] => {
  const match = /\{([^}]+)\}/.exec(token)
  return match
    ? match[1]!.split(",").flatMap((part) => expand(token.replace(match[0], part.trim())))
    : [token]
}

describe("theme contract", () => {
  describe("foundation tokens", () => {
    it("are the ones the theming guide's table lists", () => {
      const section = doc.slice(
        doc.indexOf("Required in every scheme"),
        doc.indexOf("Optional, with defaults"),
      )
      const listed = section
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .flatMap((line) => [...line.matchAll(/`(--[^`]+)`/g)].flatMap((match) => expand(match[1]!)))

      expect(listed.toSorted()).toEqual(requiredTokens.toSorted())
    })
  })

  describe.each(themes.map((theme) => [theme.id, theme] as const))("theme %s", (id, theme) => {
    const file = fileOf(theme)
    const scope = scopeOf(id)
    const shared = sharedScopeOf(theme)

    it("has a file imported into the themes layer", () => {
      expect(stylesheets).toContain(file)
      expect(uncomment(read("styles.css"))).toContain(`@import "./${file}" layer(themes);`)
    })

    it("selects only its own theme", () => {
      const selectors = (css: string): string[] =>
        cssNodes(css).flatMap((node) =>
          node.body === undefined
            ? []
            : node.prelude.startsWith("@keyframes")
              ? []
              : node.prelude.startsWith("@")
                ? selectors(node.body)
                : selectorList(node.prelude),
        )
      const scopes = [
        ...sharing(theme).map((other) => scopeOf(other.id)),
        ...(shared ? [shared] : []),
      ]
      expect(
        selectors(uncomment(read(file))).filter(
          (selector) => !scopes.some((start) => selector.startsWith(start)),
        ),
      ).toEqual([])
      const ids = new Set(sharing(theme).map((other) => other.id))
      expect(
        [...read(file).matchAll(/data-theme="([^"]*)"/g)]
          .map((match) => match[1]!)
          .filter((name) => !ids.has(name)),
      ).toEqual([])
    })

    it.each(theme.schemes.map((scheme, index) => [scheme, index] as const))(
      "defines every required token for its %s scheme",
      (scheme, index) => {
        const suffix = index === 0 ? "" : `[data-scheme="${scheme}"]`
        const selector = `${scope}${suffix}`
        const nodes = cssNodes(uncomment(read(file)))
        const block = nodes.find((node) => node.prelude === selector)
        expect(block?.body, `${file} has no ${selector} block`).toBeDefined()
        const common = shared && nodes.find((node) => node.prelude === `${shared}${suffix}`)
        const tokens = new Map([
          ...(common ? declarations(common.body!) : []),
          ...declarations(block!.body!),
        ])

        expect(tokens.get("color-scheme")).toBe(scheme)
        expect(requiredTokens.filter((token) => !tokens.has(token))).toEqual([])
      },
    )

    // A first scheme's block is shared with the others, so a colour it sets holds in the
    // next unless that restates it. Aliases and offsets from the paper resolve again
    // against the other scheme's values; a literal does not, so each one is restated or
    // listed here with why it holds in both.
    it.skipIf(theme.schemes.length < 2)(
      "restates in dark every literal colour the light block sets",
      () => {
        const holdsInBoth = new Map([
          ["--brand-tile-fg", "the logo's glyph is the bright cyan in both schemes"],
          ["--artifact-webview-bg", "a live page assumes a white ground in both schemes"],
        ])
        const nodes = cssNodes(uncomment(read(file)))
        const light = declarations(nodes.find((node) => node.prelude === scope)!.body!)
        const dark = declarations(
          nodes.find((node) => node.prelude === `${scope}[data-scheme="dark"]`)!.body!,
        )
        const literal = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?!\s*from\b)/i

        const leaking = [...light]
          .filter(([name, value]) => literal.test(value) && !dark.has(name))
          .map(([name]) => name)
          .filter((name) => !holdsInBoth.has(name))

        expect(leaking).toEqual([])
      },
    )
  })

  it("applies only the SVG filters index.html carries", () => {
    const page = readFileSync(join(process.cwd(), "index.html"), "utf8")
    const carried = new Set(
      [...page.matchAll(/<filter[^>]*\bid="([^"]+)"/g)].map((match) => match[1]),
    )
    const used = themes.flatMap((theme) =>
      [...uncomment(read(fileOf(theme))).matchAll(/url\(\s*["']?#([^"')]+)/g)].map(
        (match) => match[1]!,
      ),
    )
    expect(used.filter((id) => !carried.has(id))).toEqual([])
  })

  it("imports only manifest themes into the themes layer", () => {
    const imported = [
      ...uncomment(read("styles.css")).matchAll(/@import "\.\/([^"]+)" layer\(themes\)/g),
    ]
    expect(imported.map((match) => match[1]!).filter((file) => !themeFile(file))).toEqual([])
  })
})

// ---- (a) TSX arranges, recipes draw.

// Class strings are found in the script's syntax tree, after esbuild has compiled its
// TypeScript and JSX away (a `className` attribute becomes a `className` property). A
// class context is the value of a `className`, `…ClassName`, `…Class` or `…Classes`
// property, constant, function or assignment, the arguments of `cn()`, `clsx()` and
// `classList.add()`, `.toggle()` or `.replace()`, and the value of
// `setAttribute("class", …)`. Every string inside one counts, at any depth: in a
// ternary, an arrow, an array, a template's `${…}` or a clsx object's keys. A name the
// context reads that the file declares, such as a lookup map in
// `className={tones[tone]}` or a helper it calls, is a class context too. Strings that
// are only compared (`kind === "x"`), indexed by or matched in a `case` are not.
type Node = { readonly type: string; readonly [key: string]: unknown }

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string"

const children = (node: Node): Node[] =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  )

const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined
  if (node.type === "Identifier") return node.name as string
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined
}

const classNamed = (node: unknown): boolean =>
  /^(class|classes|className)$|(Class|Classes|ClassName)$/.test(nameOf(node) ?? "")

const comparison = new Set(["===", "!==", "==", "!="])

// The parts of a node that hold class strings because of what the node is.
const classParts = (node: Node): Node[] => {
  const parts = (...values: unknown[]): Node[] => values.filter(isNode)
  switch (node.type) {
    case "Property":
    case "PropertyDefinition":
      return !node.computed && classNamed(node.key) ? parts(node.value) : []
    case "VariableDeclarator":
      return classNamed(node.id) ? parts(node.init) : []
    case "FunctionDeclaration":
      return classNamed(node.id) ? parts(node.body) : []
    case "AssignmentExpression": {
      const target = node.left as Node
      return target.type === "MemberExpression" && !target.computed && classNamed(target.property)
        ? parts(node.right)
        : []
    }
    case "CallExpression": {
      const callee = node.callee as Node
      const args = node.arguments as Node[]
      if (callee.type === "Identifier") return /^(cn|clsx)$/.test(nameOf(callee)!) ? args : []
      if (callee.type !== "MemberExpression" || callee.computed) return []
      const method = nameOf(callee.property)
      if (method === "setAttribute") return nameOf(args[0]) === "class" ? parts(args[1]) : []
      const owner = callee.object as Node
      return /^(add|toggle|replace)$/.test(method ?? "") &&
        owner.type === "MemberExpression" &&
        nameOf(owner.property) === "classList"
        ? args
        : []
    }
    default:
      return []
  }
}

// The strings in a class context, by the node that holds each, and the names it reads.
const contents = (
  node: Node,
  strings: Map<Node, string> = new Map(),
  names: Set<string> = new Set(),
): { readonly strings: Map<Node, string>; readonly names: Set<string> } => {
  if (node.type === "Literal") {
    if (typeof node.value === "string") strings.set(node, node.value)
  } else if (node.type === "TemplateLiteral") {
    strings.set(
      node,
      (node.quasis as Node[]).map((quasi) => (quasi.value as { cooked: string }).cooked).join(" "),
    )
    for (const expression of node.expressions as Node[]) contents(expression, strings, names)
  } else if (node.type === "Identifier") {
    names.add(node.name as string)
  } else if (node.type === "BinaryExpression" && comparison.has(node.operator as string)) {
    // A comparison's strings are compared, not used as classes.
  } else if (node.type === "MemberExpression") {
    contents(node.object as Node, strings, names)
    if (node.computed && (node.property as Node).type !== "Literal")
      contents(node.property as Node, strings, names)
  } else if (
    node.type === "Property" &&
    !node.computed &&
    (node.key as Node).type === "Identifier"
  ) {
    contents(node.value as Node, strings, names)
  } else if (node.type === "SwitchCase") {
    for (const statement of node.consequent as Node[]) contents(statement, strings, names)
  } else {
    for (const child of children(node)) contents(child, strings, names)
  }
  return { strings, names }
}

// What the file declares by name: constants and functions.
const declaredNames = (program: Node): Map<string, Node[]> => {
  const found = new Map<string, Node[]>()
  const visit = (node: Node): void => {
    const declared =
      node.type === "VariableDeclarator"
        ? [nameOf(node.id), node.init]
        : node.type === "FunctionDeclaration"
          ? [nameOf(node.id), node.body]
          : []
    const [name, value] = declared
    if (typeof name === "string" && isNode(value))
      found.set(name, [...(found.get(name) ?? []), value])
    children(node).forEach(visit)
  }
  visit(program)
  return found
}

// Every class string in a script's compiled code.
const classStrings = (code: string): string[] => {
  const program = parseAst(code) as unknown as Node
  const declared = declaredNames(program)
  const queue: Node[] = []
  const collect = (node: Node): void => {
    queue.push(...classParts(node))
    children(node).forEach(collect)
  }
  collect(program)
  const seen = new Set<Node>()
  // Contexts nest, as a `cn()` call in a `className` does: each string counts once.
  const found = new Map<Node, string>()
  while (queue.length > 0) {
    const context = queue.pop()!
    if (seen.has(context)) continue
    seen.add(context)
    const { names } = contents(context, found)
    for (const name of names) queue.push(...(declared.get(name) ?? []))
  }
  return [...found.values()]
}

const compiled = async (file: string, code: string): Promise<string> =>
  (await transformWithEsbuild(code, file, { jsx: "automatic" })).code

// A class token without its variants (`hover:`, `data-[state=open]:`).
const withoutVariants = (token: string): string => {
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index++) {
    const char = token[index]
    if (char === "[" || char === "(") depth++
    else if (char === "]" || char === ")") depth--
    else if (char === ":" && depth === 0) start = index + 1
  }
  return token.slice(start)
}

// Whether a class token carries Tailwind's important modifier (`!p-2`, `hover:p-2!`).
const importantUtility = (token: string): boolean => /^!|!$/.test(withoutVariants(token))

// The utility a class token names: without its variants, `!` and a leading `-`.
const utilityOf = (token: string): string =>
  withoutVariants(token)
    .replace(/^!|!$/g, "")
    .replace(/^-(?=[a-z])/, "")

// Tailwind utilities that take a value (`p-2`, `bg-paper`, `rounded-[1px]`) by their
// prefix, and those that stand alone (`flex`, `border`). A token is checked only when
// it is one of these, so app classes such as `sidebar-item` or `grid-terminal` pass.
const valuePrefixes = (
  "accent align animate aspect auto-cols auto-rows backdrop basis bg bg-blend blur " +
  "border bottom break brightness caret clear col columns content contrast cursor " +
  "decoration delay divide drop-shadow duration ease end fill flex float font from gap " +
  "grayscale grid-cols grid-flow grid-rows grow h hue-rotate hyphens indent inset " +
  "inset-ring inset-shadow invert isolation items justify leading left line-clamp list " +
  "m mask max-h max-w mb me min-h min-w mix-blend ml mr ms mt mx my object opacity order " +
  "origin outline overflow overscroll p pb pe pl place placeholder pointer-events pr ps " +
  "pt px py right ring rotate rounded row saturate scale scheme scroll select self sepia " +
  "shadow shrink size skew snap space-x space-y start stroke table text to top touch " +
  "tracking transition translate underline-offset via w whitespace will-change wrap z"
).split(" ")
const standalone = new Set(
  (
    "absolute antialiased block blur border box-border box-content capitalize collapse " +
    "contents filter fixed flex flow-root grayscale grid grow hidden inline inline-block " +
    "inline-flex inline-grid inline-table invert invisible isolate italic line-through " +
    "list-item lowercase no-underline normal-case not-italic not-sr-only ordinal outline " +
    "overline relative resize ring rounded sepia shadow shrink slashed-zero sr-only " +
    "static sticky subpixel-antialiased table tabular-nums transform transition truncate " +
    "underline uppercase visible"
  ).split(" "),
)
// The value after a prefix: a word, a number, a fraction, or an arbitrary value, with
// an optional opacity or line-height modifier.
const valueShape = /^[a-z0-9.]+(-[a-z0-9.]+)*(\/\d+)?$|^(.*-)?(\[.+\]|\(.+\))(\/[\w.%[\]]+)?$/

const isUtility = (utility: string): boolean =>
  standalone.has(utility) ||
  valuePrefixes.some(
    (prefix) =>
      utility.startsWith(`${prefix}-`) && valueShape.test(utility.slice(prefix.length + 1)),
  )

// What TSX may use: how elements are arranged, and the size and flow of their type.
const layoutUtilities: readonly RegExp[] = [
  /^(block|inline|inline-block|inline-flex|inline-grid|flex|grid|hidden|contents|flow-root|list-item|table(-.+)?)$/,
  /^(sr-only|not-sr-only)$/,
  /^(flex-.+|grow(-.+)?|shrink(-.+)?|basis-.+|order-.+|col-.+|row-.+|auto-(cols|rows)-.+)$/,
  /^(grid-(cols|rows|flow)-.+|gap(-[xy])?-.+|justify-.+|items-.+|self-.+|place-.+)$/,
  /^content-(normal|center|start|end|between|around|evenly|baseline|stretch|\[.+\])$/,
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|space-[xy])-.+$/,
  /^(w|h|size|min-w|min-h|max-w|max-h)-.+$/,
  /^(static|fixed|absolute|relative|sticky|visible|invisible|collapse|isolate|isolation-auto)$/,
  /^(inset(-[xy])?|top|right|bottom|left|start|end|z)-(?!shadow|ring).+$/,
  /^(overflow|overscroll)(-[xy])?-.+$/,
  /^(box-(border|content)|(float|clear|object|aspect|columns)-.+)$/,
  /^((translate|scale|rotate|skew)(-[xyz])?-.+|transform(-.+)?|origin-.+)$/,
  /^(pointer-events|cursor|select|touch|resize|scroll|snap|will-change|appearance)(-.+)?$/,
  /^opacity-(0|100)$/,
  /^text-(label|caption|control|code|body|lead|heading|title)(\/.+)?$/,
  /^text-\[(length:)?[\d.]+(px|rem|em)\](\/.+)?$/,
  /^text-\[length:.+\]$/,
  /^text-(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
  /^(truncate|whitespace-.+|break-.+|wrap-.+|line-clamp-.+|hyphens-.+|leading-.+|align-.+)$/,
  /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])$/,
  /^(italic|not-italic|tabular-nums|indent-.+)$/,
]

// Arbitrary properties (`[overflow-wrap:anywhere]`) by what they set; a custom
// property is layout unless it names a token a theme owns.
const layoutProperty =
  /^(display|position|inset|top|right|bottom|left|z-index|order|(min-|max-)?(width|height)|margin.*|padding.*|gap|(row|column)-gap|flex.*|grid.*|justify-.+|align-.+|place-.+|overflow.*|overscroll-.+|visibility|transform|translate|scale|rotate|pointer-events|cursor|user-select|touch-action|scroll.*|scrollbar-gutter|overflow-wrap|white-space|word-break|text-align|line-height|font-size|font-weight|font-style|aspect-ratio|--(?!color|shadow|radius|font|transition|tw-).+)$/

const arbitraryProperty = (utility: string): string | undefined =>
  /^\[(-?-?[a-z][a-z-]*):.+\]$/.exec(utility)?.[1]

const lookUtilities = (text: string): string[] =>
  text.split(/\s+/).flatMap((token) => {
    const utility = utilityOf(token)
    const property = arbitraryProperty(utility)
    if (property) return layoutProperty.test(property) ? [] : [token]
    if (!isUtility(utility)) return []
    return layoutUtilities.some((pattern) => pattern.test(utility)) ? [] : [token]
  })

// The look utilities in a script's class strings.
const classLooks = async (file: string, code: string): Promise<string[]> =>
  classStrings(await compiled(file, code)).flatMap(lookUtilities)

const tsxLooks: Rule = {
  broken: "draws with Tailwind utilities",
  fix: "TSX may only arrange: move the look into the component's recipe, as a token-driven rule (docs/theming.md, Rules for components).",
}

// The look utilities a stylesheet's `@apply` names, by the same split as the TSX.
const applyLooks = (file: string, css = read(file)): string[] =>
  statements(uncomment(css)).flatMap(({ text }) =>
    text.startsWith("@apply") ? text.split(/\s+/).slice(1).flatMap(lookUtilities) : [],
  )

const appliedLooks: Rule = {
  broken: "applies Tailwind utilities that draw",
  fix: "A recipe may @apply only layout utilities: write the look as a declaration that reads a token (docs/theming.md, Layers).",
}

// ---- (b) No colour literals outside theme files.

const namedColours = (
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
  "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue " +
  "cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
  "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon " +
  "darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
  "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
  "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
  "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
  "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
  "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey " +
  "lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
  "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
  "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose " +
  "moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
  "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink " +
  "plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon " +
  "sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke " +
  "yellow yellowgreen"
).split(" ")
const systemColours = (
  "AccentColor AccentColorText ActiveText ButtonBorder ButtonFace ButtonText Canvas " +
  "CanvasText Field FieldText GrayText Highlight HighlightText LinkText Mark MarkText " +
  "SelectedItem SelectedItemText VisitedText"
).split(" ")
const word = (names: readonly string[], flags: string): RegExp =>
  new RegExp(`(?<![\\w-])(${names.join("|")})(?![\\w-])`, flags)
const namedColour = word(namedColours, "gi")
const systemColour = word(systemColours, "gi")
const colourFunction = /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi
const hexColour = /#[0-9a-f]{3,8}(?![\w-])/gi
const paletteColour =
  /^(bg|text|border(-[xytrblse])?|ring|outline|fill|stroke|from|via|to|divide|shadow|decoration|accent|caret|placeholder)-(white|black|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)(\/.+)?$/

const colourLiterals = (file: string, css = read(file)): string[] =>
  statements(uncomment(css)).flatMap(({ text }) => {
    if (text.startsWith("@apply"))
      return text
        .split(/\s+/)
        .slice(1)
        .filter((token) => paletteColour.test(utilityOf(token)))
    const colon = text.indexOf(":")
    if (colon < 0) return []
    const value = text
      .slice(colon + 1)
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
      .replace(/url\([^)]*\)/g, "url()")
    return [
      ...value.matchAll(hexColour),
      ...value.matchAll(colourFunction),
      ...value.matchAll(namedColour),
      ...(file === "theme/accessibility.css" ? [] : value.matchAll(systemColour)),
    ].map((match) => match[0])
  })

const colours: Rule = {
  broken: "holds colour literals outside a theme file",
  fix: "Read a foundation or component token instead, mixing tokens with color-mix() where a shade is needed (docs/theming.md, A recipe reads only tokens).",
}

// ---- (c) No `!important` outside its listed exceptions.

// Each `!important` in a stylesheet, as the rule's selector and the property, or the
// utility `@apply` marks important.
const importantDeclarations = (file: string, css = read(file)): string[] =>
  statements(uncomment(css)).flatMap(({ block, text }) => {
    const rule = block.replace(/\s+/g, " ")
    if (text.startsWith("@apply"))
      return text
        .split(/\s+/)
        .slice(1)
        .filter(importantUtility)
        .map((token) => `${rule} { @apply ${token} }`)
    const colon = text.indexOf(":")
    return colon > 0 && /!\s*important/i.test(text)
      ? [`${rule} { ${text.slice(0, colon).trim()} }`]
      : []
  })

// Where `!important` stays, and why: the exact declarations, so a new one in the same
// file fails too. Each one beats a style no layer can: an inline style or one a library
// sets. docs/theming.md lists the same files under Exceptions.
const importantExceptions: readonly {
  readonly file: string
  readonly reason: string
  readonly declarations: readonly string[]
}[] = [
  {
    file: "theme/base.css",
    reason: "stills every transition, inline ones too, while the scheme changes",
    declarations: [
      "[data-scheme-switching] *, [data-scheme-switching] *::before, [data-scheme-switching] *::after { transition }",
    ],
  },
  {
    file: "theme/accessibility.css",
    reason: "reduced motion beats transitions libraries set inline or with !important",
    declarations: [
      "*, *::before, *::after { scroll-behavior }",
      "*, *::before, *::after { transition }",
      "*, *::before, *::after { animation }",
    ],
  },
  {
    file: "backend/runner/runner.css",
    reason: "xterm sets its scrollbar slider's position and width inline",
    declarations: [
      ".runner-terminal .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider { left }",
      ".runner-terminal .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider { width }",
    ],
  },
]

const important: Rule = {
  broken: "uses !important",
  fix: "It turns the layer order around: raise the selector's specificity or put the rule in a later layer. Only a style set inline, which nothing else beats, may need it: then add the declaration to importantExceptions with its reason, and the file to docs/theming.md's Exceptions.",
}

// ---- (d) Every stylesheet is layered.

// Holds only Tailwind's `@theme` (or `@theme static`), which Tailwind puts in its own layer.
const onlyTheme = (file: string): boolean =>
  cssNodes(uncomment(read(file))).every((node) => /^@theme( static)?$/.test(node.prelude))

const imports = (css: string): { readonly target: string; readonly layered: boolean }[] =>
  cssNodes(css).flatMap((node) => {
    const match = /^@import\s+(?:url\()?["']([^"']+)["']\)?(.*)$/s.exec(node.prelude)
    return node.body === undefined && match
      ? [{ target: match[1]!, layered: /\blayer\(/.test(match[2]!) }]
      : []
  })

const resolveCss = (from: string, target: string): string | undefined =>
  target.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), target)) : undefined

const unlayered = (file: string): string[] => {
  const css = uncomment(read(file))
  const loose = cssNodes(css)
    .filter((node) => {
      if (node.body !== undefined) return !/^@layer\s+[\w.-]+$/.test(node.prelude)
      // `@reference` and `@source` only tell Tailwind what to read; they emit nothing.
      if (/^@(layer|charset|reference|source)\s/.test(node.prelude)) return false
      return !node.prelude.startsWith("@import")
    })
    .map((node) => node.prelude.split("\n")[0]!.slice(0, 40))
  const looseImports = imports(css)
    .filter(({ target, layered }) => {
      if (layered || target === "tailwindcss") return false
      const local = resolveCss(file, target)
      return !(local && stylesheets.includes(local) && onlyTheme(local))
    })
    .map(({ target }) => `@import "${target}"`)
  return [...looseImports, ...loose]
}

const layeredFromStyles = new Set(
  imports(uncomment(read("styles.css"))).flatMap(({ target, layered }) => {
    const local = resolveCss("styles.css", target)
    return local && (layered || onlyTheme(local)) ? [local] : []
  }),
)

const cssImportPattern = /^import\s+(?:[\w{}\s,*]+from\s+)?["']([^"']+\.css)["']/gm

const layers: Rule = {
  broken: "has CSS outside a layer, which beats every theme",
  fix: "Import it from styles.css with layer(…), or wrap its rules in @layer (docs/theming.md, Layers).",
}

const unlayeredStylesheets = (): Map<string, string[]> =>
  byFile([
    ...stylesheets
      .filter((file) => !layeredFromStyles.has(file))
      .map((file) => [file, unlayered(file)] as const),
    // A package's CSS imported from a script can't be wrapped: the script answers for it.
    ...scripts.map(
      (file) =>
        [
          file,
          [...read(file).matchAll(cssImportPattern)]
            .map((match) => match[1]!)
            .filter((target) => !target.startsWith("."))
            .map((target) => `imports ${target}`),
        ] as const,
    ),
  ])

describe("theme rules", () => {
  it("keeps visual utilities out of TSX class strings", async () => {
    const found = byFile(
      await Promise.all(
        scripts.map(async (file) => [file, await classLooks(file, read(file))] as const),
      ),
    )
    expect(report(tsxLooks, found)).toEqual([])
  })

  it("keeps visual utilities out of @apply", () => {
    const found = byFile(stylesheets.map((file) => [file, applyLooks(file)] as const))
    expect(report(appliedLooks, found)).toEqual([])
  })

  it("keeps colour literals in theme files", () => {
    const found = byFile(
      stylesheets
        .filter((file) => !themeFile(file))
        .map((file) => [file, colourLiterals(file)] as const),
    )
    expect(report(colours, found)).toEqual([])
  })

  it("keeps !important to its listed exceptions", () => {
    const excepted = new Map(importantExceptions.map((entry) => [entry.file, entry]))
    const found = new Map(stylesheets.map((file) => [file, importantDeclarations(file)] as const))
    const unlisted = byFile(
      [...found].map(([file, used]) => {
        const listed = excepted.get(file)?.declarations ?? []
        return [file, used.filter((declaration) => !listed.includes(declaration))] as const
      }),
    )
    expect(report(important, unlisted)).toEqual([])
    expect(
      importantExceptions.flatMap(({ file, reason, declarations: listed }) =>
        listed
          .filter((declaration) => !found.get(file)?.includes(declaration))
          .map(
            (declaration) =>
              `${file} no longer uses !important in ${declaration} (${reason}): remove it from importantExceptions, and the file from docs/theming.md's Exceptions once it has none`,
          ),
      ),
    ).toEqual([])
  })

  it("lists its exceptions in the theming guide", () => {
    const section = doc.slice(doc.indexOf("## Exceptions"))
    const named = new Set([...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
    expect(
      importantExceptions
        .filter(({ file }) => !named.has(file))
        .map(({ file }) => `docs/theming.md's Exceptions does not name ${file}`),
    ).toEqual([])
  })

  it("puts every stylesheet in a layer", () => {
    expect(report(layers, unlayeredStylesheets())).toEqual([])
  })
})

// The checks themselves, against code that breaks the rules, so a blind spot fails here
// rather than letting the source drift.
describe("theme rule checks", () => {
  describe("class strings", () => {
    it.each([
      ["a className", '<div data-x="1" className="flex bg-paper" />'],
      [
        "a template's ternary",
        'const X = (on: boolean) => <i className={`row ${on ? "bg-paper" : ""}`} />',
      ],
      [
        "an arrow in a condition",
        'const X = (all: { on: boolean }[]) => <i className={all.some((one) => one.on) ? "bg-paper" : ""} />',
      ],
      [
        "a multiline ternary",
        'const X = (on: boolean) => (\n  <i\n    className={\n      on\n        ? "bg-paper"\n        : "flex"\n    }\n  />\n)',
      ],
      [
        "a helper named for classes",
        'export const itemClass = (on: boolean) => (on ? "bg-paper" : "")',
      ],
      [
        "a lookup map the className reads",
        'const tones = { danger: "bg-paper", ok: "flex" }\nconst X = (tone: "danger" | "ok") => <i className={tones[tone]} />',
      ],
      [
        "a helper the className calls",
        'function look(on: boolean) { return on ? "bg-paper" : "" }\nconst X = (on: boolean) => <i className={look(on)} />',
      ],
      [
        "a clsx object's keys",
        'const X = (on: boolean) => <i className={clsx({ "bg-paper": on })} />',
      ],
      [
        "an array joined",
        'const X = (on: boolean) => <i className={["flex", on && "bg-paper"].join(" ")} />',
      ],
      ["a cn() call", 'const X = (on: boolean) => <i className={cn("flex", on && "bg-paper")} />'],
      ["a ClassName prop", '<Popover contentClassName="flex bg-paper" />'],
      ["classList.add()", 'document.body.classList.add("flex", "bg-paper")'],
      ["classList.toggle()", 'document.body.classList.toggle("bg-paper", true)'],
      ['setAttribute("class", …)', 'document.body.setAttribute("class", `flex ${"bg-paper"}`)'],
      ["a className assignment", 'document.body.className = "bg-paper"'],
    ])("sees a look in %s", async (_, code) => {
      expect(await classLooks("example.tsx", code)).toEqual(["bg-paper"])
    })

    it("ignores strings that are compared, indexed by or matched", async () => {
      const code = [
        "const X = (kind: string, tones: Record<string, string>) => (",
        '  <i className={kind === "shadow" ? tones["border"] : "flex"} />',
        ")",
        'const toneClass = (kind: string) => { switch (kind) { case "border": return "flex"; default: return "" } }',
      ].join("\n")
      expect(await classLooks("example.tsx", code)).toEqual([])
    })
  })

  it("sees a look in @apply", () => {
    expect(
      applyLooks(
        "example.css",
        ".x { @apply flex border opacity-50 uppercase rounded-[3px] bg-[#f00]; }",
      ),
    ).toEqual(["border", "opacity-50", "uppercase", "rounded-[3px]", "bg-[#f00]"])
  })

  it("sees system colours in any case", () => {
    expect(colourLiterals("example.css", ".x { background: canvas; color: CanvasText; }")).toEqual([
      "canvas",
      "CanvasText",
    ])
  })

  it("sees !important in a declaration and after a utility's variants", () => {
    expect(
      importantDeclarations(
        "example.css",
        ".x { color: var(--color-ink) !important; @apply flex hover:!p-2 data-[a=b]:p-1!; }",
      ),
    ).toEqual([".x { color }", ".x { @apply hover:!p-2 }", ".x { @apply data-[a=b]:p-1! }"])
  })
})
