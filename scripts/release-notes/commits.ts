/** A commit as git gives it: its subject and its message's body. */
export type RawCommit = { readonly sha: string; readonly subject: string; readonly body: string }

/** A user-visible commit, its subject taken apart. */
export type Commit = {
  readonly sha: string
  readonly type: "feat" | "fix" | "perf"
  readonly scope: string | undefined
  /** The subject without its type, scope and pull request number. */
  readonly subject: string
  readonly pr: number | undefined
  /** The pull request body's `## What`, trimmed. */
  readonly what: string
  /** Its `## Why`, trimmed: what the change is for, which a line may say when it isn't plain. */
  readonly why: string
}

// The scopes of changes that are not the app: the try demo, the wire between processes, the
// atlas, the release pipeline, CI, tests and dependencies, and the scripts and harness
// adapters around the product. The chat view ships behind a flag, so anything scoped to it is
// never announced.
export const excludedScopes: ReadonlySet<string> = new Set([
  "demo",
  "wire",
  "atlas",
  "release",
  "scripts",
  "harnesses",
  "chat",
  "ci",
  "test",
  "tests",
  "e2e",
  "deps",
  "bench",
  "benchmark",
  "specs",
  "flakes",
])

const conventional =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?: (?<subject>.+?)(?: \(#(?<pr>\d+)\))?$/

/** The longest `## What` handed to the model: a pull request's own words, not its essay. */
export const maxWhat = 700
/** The longest `## Why`: the reason, not the case for it. */
export const maxWhy = 400

/** The chat view ships behind a flag, and the try demo is not the app: neither is announced. */
export const chat = /\bchats?\b/i
export const demo = /\bdemos?\b/i
const unannounced = (text: string): boolean => chat.test(text) || demo.test(text)

// A list item or a numbered one starts a block of its own.
const itemStart = /^\s*(?:[-*+]|\d+\.)\s/

// A sentence that points at an issue or another pull request, as "Builds on #373" or "Closes
// #383": the model would take the number for one it may cite.
const reference = /#\d+\b/

/**
 * The text under a pull request body's `## <heading>`, up to the next heading, cut at `max`.
 * `references` keeps the sentences that point at an issue or a pull request.
 */
const sectionOf = (body: string, heading: string, max: number, references = true): string => {
  const found = new RegExp(
    `^## ${heading}[ \\t]*\\r?\\n(?<text>[\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "m",
  ).exec(body)
  // The bodies are hard-wrapped, so a sentence runs over lines: join each paragraph or list
  // item before cutting into sentences, then drop the sentences that name what isn't announced.
  const blocks: string[] = []
  let open = false
  // Links are the pull request's business; a URL in what the model reads is a way to steer it.
  // So does the template's prompt, left in an unfilled section.
  const plain = (found?.groups?.text ?? "")
    .replaceAll("\r", "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
  for (const line of plain.split("\n")) {
    if (!line.trim()) {
      blocks.push("")
      open = false
    } else if (open && !itemStart.test(line)) {
      blocks[blocks.length - 1] += ` ${line.trim()}`
    } else {
      blocks.push(line.trimEnd())
      open = true
    }
  }
  const text = blocks
    .flatMap((block) => {
      const kept = block
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !unannounced(sentence) && (references || !reference.test(sentence)))
        .join(" ")
      // A block that was all about it goes whole; a blank line stays a blank line.
      return block && !kept ? [] : [kept]
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text
}

/** The text under a pull request body's `## What` heading, up to the next heading. */
export const whatOf = (body: string): string => sectionOf(body, "What", maxWhat)

/** The text under its `## Why` heading, the same way. */
export const whyOf = (body: string): string => sectionOf(body, "Why", maxWhy, false)

/**
 * The commit, when it is a feat, fix or perf change a person could see; `undefined` for any
 * other type, for the excluded scopes, and for a subject that isn't a conventional one.
 */
export const parseCommit = (raw: RawCommit): Commit | undefined => {
  const found = conventional.exec(raw.subject.trim())?.groups
  if (!found) return undefined
  const { type, scope, subject, pr } = found
  if (type !== "feat" && type !== "fix" && type !== "perf") return undefined
  if (unannounced(subject!)) return undefined
  if (scope?.split(",").some((part) => excludedScopes.has(part.trim()))) return undefined
  return {
    sha: raw.sha,
    type,
    scope: scope || undefined,
    subject: subject!,
    pr: pr ? Number(pr) : undefined,
    what: whatOf(raw.body),
    why: whyOf(raw.body),
  }
}

// A revert, by what it says it undoes.
type Revert = {
  /** The full subject it quotes, lowercase and without a pull request number. */
  readonly quoted: string | undefined
  /** The pull request number the quote carries. */
  readonly quotedPr: number | undefined
  /** For `revert(scope): subject`: the scope and subject, which the type can't be told from. */
  readonly typed: { readonly scope: string | undefined; readonly subject: string } | undefined
  /** Pull requests it names: inside the quote, or after "reverts" in its body. */
  readonly prs: readonly number[]
  /** Its own full subject, lowercase and without a number, for a later revert of it. */
  readonly own: string
}

const withoutPr = (subject: string): string =>
  subject
    .replace(/ \(#\d+\)$/, "")
    .trim()
    .toLowerCase()

const revertOf = (raw: RawCommit): Revert | undefined => {
  const subject = raw.subject.trim()
  const quoted = /^Revert "(?<inner>.+)"(?: \(#\d+\))?$/.exec(subject)?.groups?.["inner"]
  const typed = /^revert(?:\((?<scope>[^)]*)\))?!?: (?<inner>.+)$/i.exec(subject)?.groups
  if (!quoted && !typed) return undefined
  const named = quoted ?? typed!["inner"]!.replace(/ \(#\d+\)$/, "")
  return {
    quoted: quoted ? withoutPr(quoted) : undefined,
    quotedPr: quoted ? Number(/\(#(\d+)\)$/.exec(quoted)?.[1]) || undefined : undefined,
    typed: typed
      ? { scope: typed["scope"] || undefined, subject: named.trim().toLowerCase() }
      : undefined,
    prs: [
      ...[...named.matchAll(/#(\d+)/g)].map((found) => Number(found[1])),
      ...[...raw.body.matchAll(/\breverts?\b[^\n]*?#(\d+)/gi)].map((found) => Number(found[1])),
    ],
    own: withoutPr(subject),
  }
}

/**
 * The user-visible commits of a range. A commit that a revert in the range undoes is left out
 * along with the revert; a revert of a revert brings the original back. Commits are taken
 * oldest first, and a revert matches by the full subject it quotes (type and scope included),
 * by a typed `revert(scope): subject` with the same scope and subject, or by a pull request it names.
 */
export const parseCommits = (raws: readonly RawCommit[]): Commit[] => {
  type Entry = { commit: Commit; full: string; undoneBy: number | undefined }
  const entries: Entry[] = []
  const reverts: { revert: Revert; active: boolean }[] = []
  for (const raw of raws) {
    const revert = revertOf(raw)
    if (!revert) {
      const commit = parseCommit(raw)
      if (commit) entries.push({ commit, full: withoutPr(raw.subject), undoneBy: undefined })
      continue
    }
    const index = reverts.length
    // A revert of an earlier revert cancels it, and what it had undone stands again.
    const earlier = reverts.findIndex(
      (each) => each.active && revert.quoted !== undefined && each.revert.own === revert.quoted,
    )
    if (earlier >= 0) {
      reverts[earlier]!.active = false
      for (const entry of entries) if (entry.undoneBy === earlier) entry.undoneBy = undefined
      reverts.push({ revert, active: false })
      continue
    }
    reverts.push({ revert, active: true })
    for (const entry of entries) {
      const { commit } = entry
      const byQuote =
        revert.quoted === entry.full &&
        (revert.quotedPr === undefined || revert.quotedPr === commit.pr)
      const byType =
        revert.typed !== undefined &&
        revert.typed.subject === commit.subject.toLowerCase() &&
        revert.typed.scope === commit.scope
      const byNumber = commit.pr !== undefined && revert.prs.includes(commit.pr)
      if (entry.undoneBy === undefined && (byQuote || byType || byNumber)) entry.undoneBy = index
    }
  }
  return entries.flatMap((entry) => (entry.undoneBy === undefined ? [entry.commit] : []))
}
