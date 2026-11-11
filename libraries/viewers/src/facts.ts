import type { SyntaxNode, Tree } from "@lezer/common"

import { languageOf, type Language } from "./highlight/languages.js"

// What a change to a file can be said to be, from facts alone: where it sits in the file's
// parse (the declaration around it, an import, a test, a Markdown heading) and the exact
// tokens a small edit changed. Never why. The two sides of the file are parsed with the
// parsers the viewers highlight with, loaded the first time a file's facts are asked for.

/** A line of a diff's hunk. */
export type FactLine = { readonly kind: "context" | "add" | "remove"; readonly text: string }
/** A hunk as git prints it: its start and size on each side, and its lines. */
export type FactHunk = {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly FactLine[]
}

// ── Tokens ─────────────────────────────────────────────────────────────────────────────

/** Text ranges `[from, to)` of a line that its replacement changed. */
export type Marks = readonly (readonly [number, number])[]

const tokenPattern = /[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|\s+|[^]/gu
const maxTokens = 300

const tokensOf = (text: string): { text: string; from: number }[] =>
  [...text.matchAll(tokenPattern)].map((match) => ({ text: match[0], from: match.index }))

/**
 * Which tokens of two versions of a line changed: the ranges of each, runs of changed tokens
 * joined across the blanks between them. Null where the lines have too little in common for
 * marks to say anything (less than `similar` of the longer one is shared), or are too long.
 */
export const tokenDiff = (
  before: string,
  after: string,
  similar = 0.5,
): { readonly before: Marks; readonly after: Marks } | null => {
  const a = tokensOf(before)
  const b = tokensOf(after)
  if (a.length > maxTokens || b.length > maxTokens) return null
  // The longest common run of tokens, by the usual table.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i]!.text === b[j]!.text
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const keptA = new Set<number>()
  const keptB = new Set<number>()
  let shared = 0
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i]!.text === b[j]!.text) {
      keptA.add(i)
      keptB.add(j)
      if (a[i]!.text.trim() !== "") shared += a[i]!.text.length
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  const longer = Math.max(
    before.trim().replaceAll(/\s+/g, "").length,
    after.trim().replaceAll(/\s+/g, "").length,
  )
  if (longer === 0 || shared / longer < similar) return null
  const runs = (tokens: typeof a, kept: Set<number>, text: string): Marks => {
    const out: [number, number][] = []
    for (const [at, token] of tokens.entries()) {
      if (kept.has(at)) continue
      const end = token.from + token.text.length
      const last = out.at(-1)
      // Blanks between two changed tokens belong to the run.
      if (last && text.slice(last[1], token.from).trim() === "") last[1] = end
      else out.push([token.from, end])
    }
    // A run of blanks alone marks nothing.
    return out.filter(([from, to]) => text.slice(from, to).trim() !== "")
  }
  return { before: runs(a, keptA, before), after: runs(b, keptB, after) }
}

// ── The parse ──────────────────────────────────────────────────────────────────────────

/** What a declaration is, as a person says it. */
export type DeclarationKind =
  | "function"
  | "class"
  | "method"
  | "property"
  | "type"
  | "interface"
  | "enum"
  | "const"
  | "test"

export type Declaration = {
  readonly kind: DeclarationKind
  /** Its name as shown: `verify()` for a function, `Session` for a type, a test's title. */
  readonly name: string
  /** What makes it the same one on the other side. */
  readonly key: string
  /** The lines it spans, from 1. */
  readonly from: number
  readonly to: number
  /** Its text with blanks folded, to tell whether it changed. */
  readonly body: string
}

type Heading = { readonly text: string; readonly line: number }
type Import = { readonly names: readonly string[]; readonly from: number; readonly to: number }

/** A file side read as far as facts need. */
export type Outline = {
  readonly declarations: readonly Declaration[]
  readonly imports: readonly Import[]
  readonly headings: readonly Heading[]
}

const empty: Outline = { declarations: [], imports: [], headings: [] }

const javascript = new Set<Language>(["javascript", "typescript", "tsx"])
const testFunctions = new Set(["it", "test", "describe"])

const foldBlanks = (text: string): string => text.replaceAll(/\s+/g, " ").trim()

/** The local names an `import … from …` declaration brings in. */
const importNames = (text: string): string[] => {
  const clause = /^import\s+(?:type\s+)?([^]*?)\s*from\s*["']/.exec(text)?.[1]
  if (!clause) return []
  const names: string[] = []
  const braces = /\{([^}]*)\}/.exec(clause)?.[1]
  const outside = clause.replace(/\{[^}]*\}/, "")
  for (const part of outside.split(",")) {
    const name = /(?:\*\s*as\s+)?([\p{L}_$][\p{L}\p{N}_$]*)\s*$/u.exec(part.trim())?.[1]
    if (name) names.push(name)
  }
  for (const part of (braces ?? "").split(",")) {
    const name = /([\p{L}_$][\p{L}\p{N}_$]*)\s*$/u.exec(part.trim())?.[1]
    if (name) names.push(name)
  }
  return names
}

const outlineOfScript = (tree: Tree, text: string): Outline => {
  const starts = [0]
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1)
  const lineOf = (offset: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
  const declarations: Declaration[] = []
  const imports: Import[] = []
  const textOf = (node: SyntaxNode): string => text.slice(node.from, node.to)
  const nameOf = (node: SyntaxNode, types: readonly string[]): string | undefined => {
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (types.includes(child.name)) return textOf(child)
    return undefined
  }
  const add = (
    node: SyntaxNode,
    kind: DeclarationKind,
    name: string,
    key: string,
    span: SyntaxNode = node,
  ): void => {
    declarations.push({
      kind,
      name,
      key,
      from: lineOf(span.from),
      to: lineOf(Math.max(span.from, span.to - 1)),
      body: foldBlanks(textOf(span)),
    })
  }
  const testTitle = (node: SyntaxNode): string | undefined => {
    const callee = node.firstChild
    const args = node.getChild("ArgList")
    const first = args?.firstChild?.nextSibling
    if (!callee || first?.name !== "String") return undefined
    const head = callee.name === "MemberExpression" ? callee.firstChild : callee
    if (head?.name !== "VariableName" || !testFunctions.has(textOf(head))) return undefined
    return textOf(first).slice(1, -1)
  }
  const visit = (node: SyntaxNode, scope: "top" | "class" | "inner", owner: string): void => {
    const into = (next: "top" | "class" | "inner", who = owner) => {
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, next, who)
    }
    switch (node.name) {
      case "ExportDeclaration":
        return into(scope)
      case "ImportDeclaration": {
        const source = textOf(node)
        imports.push({ names: importNames(source), from: lineOf(node.from), to: lineOf(node.to) })
        return
      }
      case "FunctionDeclaration": {
        const name = nameOf(node, ["VariableDefinition"])
        if (scope === "top" && name) add(node, "function", `${name}()`, `function ${name}`)
        return into("inner")
      }
      case "ClassDeclaration": {
        const name = nameOf(node, ["VariableDefinition", "TypeDefinition"])
        if (scope === "top" && name) add(node, "class", name, `class ${name}`)
        for (let child = node.firstChild; child; child = child.nextSibling)
          visit(child, scope === "top" ? "class" : "inner", name ?? "")
        return
      }
      case "MethodDeclaration":
      case "PropertyDeclaration": {
        const name = nameOf(node, ["PropertyDefinition"])
        if (scope === "class" && name) {
          const method = node.name === "MethodDeclaration"
          add(node, method ? "method" : "property", method ? `${name}()` : name, `${owner}.${name}`)
        }
        return into("inner")
      }
      case "TypeAliasDeclaration":
      case "InterfaceDeclaration":
      case "EnumDeclaration": {
        const name = nameOf(node, ["TypeDefinition", "Definition", "VariableDefinition"])
        const kind =
          node.name === "TypeAliasDeclaration"
            ? "type"
            : node.name === "InterfaceDeclaration"
              ? "interface"
              : "enum"
        if (scope === "top" && name) add(node, kind, name, `${kind} ${name}`)
        return into("inner")
      }
      case "VariableDeclaration": {
        if (scope === "top") {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name !== "VariableDefinition") continue
            const name = textOf(child)
            let init = child.nextSibling
            while (init && init.name !== "Equals" && init.name !== ",") init = init.nextSibling
            init = init?.name === "Equals" ? init.nextSibling : null
            const fn = init?.name === "ArrowFunction" || init?.name === "FunctionExpression"
            // A const of several names is each of them; its text is the whole statement.
            add(node, fn ? "function" : "const", fn ? `${name}()` : name, `const ${name}`)
          }
        }
        return into("inner")
      }
      case "CallExpression": {
        const title = testTitle(node)
        if (title !== undefined) add(node, "test", title, `test ${title}`)
        return into("inner")
      }
      default:
        // Only the file, and a class's body, are the places a declaration counts in.
        return into(node.name === "Script" || node.name === "ClassBody" ? scope : "inner", owner)
    }
  }
  visit(tree.topNode, "top", "")
  return { declarations, imports, headings: [] }
}

const outlineOfMarkdown = (tree: Tree, text: string): Outline => {
  const headings: Heading[] = []
  tree.iterate({
    enter: (node) => {
      if (!/^(ATX|Setext)Heading\d$/.test(node.name)) return
      const raw = text.slice(node.from, node.to).split("\n")[0] ?? ""
      const heading = raw
        .replace(/^#{1,6}\s*/, "")
        .replace(/\s*#*\s*$/, "")
        .trim()
      headings.push({
        text: heading,
        line: text.slice(0, node.from).split("\n").length,
      })
      return false
    },
  })
  return { ...empty, headings }
}

/** A file side outlined: its declarations, imports and headings; empty for a language without. */
export const outlineOf = async (path: string, text: string | null): Promise<Outline> => {
  const language = languageOf(path)
  if (text === null || !language) return empty
  if (!javascript.has(language) && language !== "markdown") return empty
  const { parseText } = await import("./highlight/lines.js")
  const tree = await parseText(language, text)
  if (!tree) return empty
  return language === "markdown" ? outlineOfMarkdown(tree, text) : outlineOfScript(tree, text)
}

// ── The facts ──────────────────────────────────────────────────────────────────────────

/** Where one change sits, and what is new or gone there. */
export type Place =
  | {
      readonly kind: "imports"
      readonly added: readonly string[]
      readonly removed: readonly string[]
    }
  | {
      readonly kind: "in" | "new" | "removed"
      readonly declaration: DeclarationKind
      readonly name: string
    }
  | { readonly kind: "under"; readonly heading: string }

/** The exact tokens a small edit replaced: `7 → 30`; `from` is empty for an insertion. */
export type Edit = { readonly from: string; readonly to: string }

/** What is said of one hunk, by its index. */
export type ChangeFact = {
  /** Where its stretches of changed lines sit, in order, one for each place. */
  readonly places: readonly Place[]
  readonly edit: Edit | undefined
  /** The lines it spans, from 1: on the new side, or the old for one that only removes. */
  readonly lines: { readonly from: number; readonly to: number }
}

/** What is said of a file's change as a whole. */
export type FileFacts = {
  readonly changes: readonly ChangeFact[]
  readonly imports: { readonly added: readonly string[]; readonly removed: readonly string[] }
  readonly declarations: {
    readonly added: readonly Declaration[]
    readonly removed: readonly Declaration[]
    readonly changed: readonly Declaration[]
  }
  /** Headings (Markdown) with a change under them, in order. */
  readonly headings: readonly string[]
}

type Changed = {
  readonly added: { from: number; to: number } | undefined
  readonly removed: { from: number; to: number } | undefined
  readonly first: number
  readonly last: number
}

type Marked = { line: number; blank: boolean }

const rangeOf = (lines: readonly Marked[]): { from: number; to: number } | undefined => {
  const text = lines.filter((each) => !each.blank)
  const use = text.length > 0 ? text : lines
  return use.length === 0 ? undefined : { from: use[0]!.line, to: use.at(-1)!.line }
}

/**
 * The lines each stretch of a hunk changed (lines added and removed with no unchanged line
 * between them), as ranges from 1 on the new and the old side; blank lines at an end of a
 * range are not counted, unless all are blank. Git joins stretches a few lines apart into one
 * hunk, so a hunk may sit in more than one place.
 */
const changedLines = (hunk: FactHunk): Changed[] => {
  let old = hunk.oldCount > 0 ? hunk.oldStart : hunk.oldStart + 1
  let now = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1
  const stretches: Changed[] = []
  let added: Marked[] = []
  let removed: Marked[] = []
  const flush = (): void => {
    if (added.length === 0 && removed.length === 0) return
    const adds = rangeOf(added)
    const removes = rangeOf(removed)
    stretches.push({
      added: adds,
      removed: removes,
      first: adds?.from ?? removes?.from ?? now,
      last: adds?.to ?? removes?.to ?? now,
    })
    added = []
    removed = []
  }
  for (const line of hunk.lines) {
    const blank = line.text.trim() === ""
    if (line.kind === "add") {
      added.push({ line: now, blank })
      now += 1
    } else if (line.kind === "remove") {
      removed.push({ line: old, blank })
      old += 1
    } else {
      flush()
      old += 1
      now += 1
    }
  }
  flush()
  return stretches
}

const around = (
  declarations: readonly Declaration[],
  range: { from: number; to: number },
): Declaration | undefined =>
  declarations
    .filter((each) => each.from <= range.from && each.to >= range.to)
    .toSorted((a, b) => a.to - a.from - (b.to - b.from))[0]

const overlapping = (outline: Outline, range: { from: number; to: number }): Import[] =>
  outline.imports.filter((each) => each.from <= range.to && each.to >= range.from)

const within = (outline: Outline, range: { from: number; to: number }): boolean =>
  outline.imports.some((each) => each.from <= range.from && each.to >= range.to)

const headingAbove = (outline: Outline, line: number): string | undefined =>
  outline.headings.findLast((each) => each.line <= line)?.text

/** The one token run a single replaced line changed, if it is a small edit. */
const editOf = (hunk: FactHunk): Edit | undefined => {
  const changed = hunk.lines.filter((line) => line.kind !== "context")
  const [was, now] = changed
  if (changed.length !== 2 || was?.kind !== "remove" || now?.kind !== "add") return undefined
  const marks = tokenDiff(was.text, now.text)
  if (!marks || marks.before.length > 1 || marks.after.length > 1) return undefined
  const from = marks.before[0] ? was.text.slice(...marks.before[0]) : ""
  const to = marks.after[0] ? now.text.slice(...marks.after[0]) : ""
  if (from === "" && to === "") return undefined
  return from.length <= 40 && to.length <= 40 ? { from, to } : undefined
}

const placeOf = (changed: Changed, before: Outline, after: Outline): Place | undefined => {
  const { added, removed } = changed
  // Only imports changed: which names came and went.
  const importsOnly =
    (added || removed) && (!added || within(after, added)) && (!removed || within(before, removed))
  if (importsOnly) {
    const names = (outline: Outline, range: { from: number; to: number } | undefined) =>
      new Set(range ? overlapping(outline, range).flatMap((each) => each.names) : [])
    const now = names(after, added)
    const was = names(before, removed)
    return {
      kind: "imports",
      added: [...now].filter((name) => !was.has(name)),
      removed: [...was].filter((name) => !now.has(name)),
    }
  }
  const inside = added ? around(after.declarations, added) : undefined
  if (inside) {
    const known = before.declarations.some((each) => each.key === inside.key)
    return { kind: known ? "in" : "new", declaration: inside.kind, name: inside.name }
  }
  const gone = !added && removed ? around(before.declarations, removed) : undefined
  if (gone) {
    const known = after.declarations.some((each) => each.key === gone.key)
    return { kind: known ? "in" : "removed", declaration: gone.kind, name: gone.name }
  }
  const outline = added ? after : before
  const heading = headingAbove(outline, changed.first)
  return heading === undefined ? undefined : { kind: "under", heading }
}

const keyed = (outline: Outline): Map<string, Declaration> =>
  new Map(outline.declarations.map((each) => [each.key, each]))

const importedNames = (outline: Outline): Set<string> =>
  new Set(outline.imports.flatMap((each) => each.names))

/**
 * The facts of one file's change, from its two sides and its hunks: where each hunk sits,
 * the exact tokens of a small edit, and the declarations, imports, tests and headings that
 * came, went or changed. Null where the file's language gives no facts.
 */
export const factsOf = async (input: {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
  readonly hunks: readonly FactHunk[]
}): Promise<FileFacts | null> => {
  const language = languageOf(input.path)
  if (!language || (!javascript.has(language) && language !== "markdown")) return null
  const [before, after] = await Promise.all([
    outlineOf(input.path, input.before),
    outlineOf(input.path, input.after),
  ])
  const changes = input.hunks.map((hunk): ChangeFact => {
    const stretches = changedLines(hunk)
    const places: Place[] = []
    for (const stretch of stretches) {
      const place = placeOf(stretch, before, after)
      if (place && JSON.stringify(place) !== JSON.stringify(places.at(-1))) places.push(place)
    }
    return {
      places,
      edit: editOf(hunk),
      lines: {
        from: stretches[0]?.first ?? hunk.newStart,
        to: stretches.at(-1)?.last ?? hunk.newStart,
      },
    }
  })
  const was = keyed(before)
  const now = keyed(after)
  const importsWas = importedNames(before)
  const importsNow = importedNames(after)
  return {
    changes,
    imports: {
      added: [...importsNow].filter((name) => !importsWas.has(name)),
      removed: [...importsWas].filter((name) => !importsNow.has(name)),
    },
    declarations: {
      added: [...now.values()].filter((each) => !was.has(each.key)),
      removed: [...was.values()].filter((each) => !now.has(each.key)),
      changed: [...now.values()].filter((each) => {
        const old = was.get(each.key)
        return old !== undefined && old.body !== each.body
      }),
    },
    headings: [
      ...new Set(
        changes.flatMap((change) =>
          change.places.flatMap((place) => (place.kind === "under" ? [place.heading] : [])),
        ),
      ),
    ],
  }
}
