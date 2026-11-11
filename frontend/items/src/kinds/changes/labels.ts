import type { ChangeFact, Declaration, Edit, FileFacts, Place } from "@novadeck/viewers/facts"

// Facts as words: where a change sits and what a file's change came to, in parts a view draws
// (a kind word quiet, a name in code, the tokens of an edit as was and now). Only what git and
// the parse say: never why.

/** A piece of a label: plain words, a kind word, a name, or the tokens an edit replaced. */
export type Part = {
  readonly text: string
  readonly kind: "plain" | "word" | "code" | "was" | "now"
}

const plain = (text: string): Part => ({ text, kind: "plain" })
const word = (text: string): Part => ({ text, kind: "word" })
const code = (text: string): Part => ({ text, kind: "code" })

/** Parts with `with` between them. */
const joined = (lists: readonly (readonly Part[])[], between = ", "): Part[] =>
  lists.flatMap((list, at) => (at === 0 ? [...list] : [plain(between), ...list]))

const editParts = (edit: Edit): Part[] => {
  if (edit.from === "") return [word("adds"), plain(" "), { text: edit.to, kind: "now" }]
  if (edit.to === "") return [word("drops"), plain(" "), { text: edit.from, kind: "was" }]
  return [{ text: edit.from, kind: "was" }, plain(" → "), { text: edit.to, kind: "now" }]
}

const testWord = (place: Extract<Place, { name: string }>): string =>
  place.declaration === "test" ? "test " : ""

const placeOne = (place: Place): Part[] => {
  if (place.kind === "imports") {
    const added = place.added.map((name) => [code(name)])
    const removed = place.removed.map((name) => [{ text: name, kind: "was" as const }])
    if (added.length > 0 && removed.length > 0)
      return [
        word("imports"),
        plain(" "),
        ...joined(removed),
        plain(" → "),
        ...joined(added).map(nowOf),
      ]
    if (added.length > 0) return [word("imports"), plain(" "), ...joined(added)]
    if (removed.length > 0) return [word("imports removed"), plain(" "), ...joined(removed)]
    return [word("imports")]
  }
  if (place.kind === "under") return [word("under"), plain(` ${place.heading}`)]
  const name = place.declaration === "test" ? plain(place.name) : code(place.name)
  return [word(`${place.kind} ${testWord(place)}`.trim()), plain(" "), name]
}

/**
 * Where a change sits: the declarations around its stretches of lines, the imports it touches,
 * the heading above; and, if it replaced one token, the tokens.
 */
export const placeParts = (places: readonly Place[], edit: Edit | undefined): Part[] => {
  const parts = joined(places.map(placeOne), " · ")
  return edit ? [...parts, ...(parts.length > 0 ? [plain(" ")] : []), ...editParts(edit)] : parts
}

const nowOf = (part: Part): Part => (part.kind === "code" ? { ...part, kind: "now" } : part)

/** What a change is headed by: "2/4 in requireUser()", and the lines it spans. */
export const headParts = (
  index: number,
  total: number,
  fact: ChangeFact | undefined,
  lines: { from: number; to: number },
  onlyRemoves = false,
): { n: string; place: Part[]; where: string } => {
  const range = lines.from === lines.to ? `${lines.from}` : `${lines.from}–${lines.to}`
  const where = `${onlyRemoves ? "was " : ""}${lines.from === lines.to ? "line" : "lines"} ${range}`
  return {
    n: total > 1 ? `${index + 1}/${total}` : "",
    place: placeParts(fact?.places ?? [], fact?.edit),
    where,
  }
}

const names = (list: readonly Declaration[], most = 3): Part[] => {
  const shown = list.slice(0, most).map((each) => [code(each.name)])
  const more = list.length - shown.length
  return [...joined(shown), ...(more > 0 ? [plain(` and ${more} more`)] : [])]
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A class's members and a test's contents are said with the class and the test. */
const topLevel = (list: readonly Declaration[], all: readonly Declaration[]): Declaration[] =>
  list.filter(
    (each) =>
      each.kind !== "test" &&
      !(
        (each.kind === "method" || each.kind === "property") &&
        all.some((other) => other.kind === "class" && each.key.startsWith(`${other.name}.`))
      ),
  )

/** The tests changed that have no test of their own inside them changed too. */
const leafTests = (changed: readonly Declaration[]): Declaration[] => {
  const tests = changed.filter((each) => each.kind === "test")
  return tests.filter(
    (each) =>
      !tests.some((other) => other !== each && other.from >= each.from && other.to <= each.to),
  )
}

/**
 * What a file's change came to, in one line: the declarations new, removed and changed, the
 * tests, the imports, the headings; or, for a file without facts, how many changes it holds.
 */
export const summaryParts = (
  facts: FileFacts | null,
  file: { readonly status: "added" | "modified" | "deleted" | "renamed" },
  changes: number,
): Part[] => {
  const groups: Part[][] = []
  if (facts) {
    const { declarations, imports, headings } = facts
    const everything = [...declarations.added, ...declarations.removed, ...declarations.changed]
    const added = topLevel(declarations.added, declarations.added)
    const removed = topLevel(declarations.removed, declarations.removed)
    const changed = topLevel(declarations.changed, everything)
    if (file.status === "added" && added.length > 0)
      groups.push([word("new"), plain(" "), ...names(added, 4)])
    else {
      if (changed.length > 0) groups.push([word("changed"), plain(" "), ...names(changed)])
      if (added.length > 0) groups.push([word("new"), plain(" "), ...names(added)])
      if (removed.length > 0) groups.push([word("removed"), plain(" "), ...names(removed)])
    }
    const newTests = declarations.added.filter((each) => each.kind === "test")
    const goneTests = declarations.removed.filter((each) => each.kind === "test")
    const changedTests = leafTests(declarations.changed)
    if (newTests.length > 0) groups.push([word("tests"), plain(` +${newTests.length}`)])
    if (changedTests.length > 0 && file.status !== "added")
      groups.push([word("tests changed"), plain(` ${changedTests.length}`)])
    if (goneTests.length > 0) groups.push([word("tests"), plain(` −${goneTests.length}`)])
    if (imports.added.length + imports.removed.length > 0)
      groups.push([
        word("imports"),
        plain(" "),
        ...joined([
          ...imports.added.map((name) => [code(name)]),
          ...imports.removed.map((name) => [{ text: name, kind: "was" as const }]),
        ]),
      ])
    if (headings.length > 0) groups.push([word("under"), plain(` ${headings.join(", ")}`)])
    // One small edit says its own tokens.
    const only = facts.changes.length === 1 ? facts.changes[0] : undefined
    if (
      only?.edit &&
      only.places.length === 1 &&
      only.places[0]?.kind === "in" &&
      groups.length <= 1
    )
      return placeParts(only.places, only.edit)
  }
  if (groups.length === 0) return [plain(count(changes, "change", "changes"))]
  return joined(groups, " · ")
}
