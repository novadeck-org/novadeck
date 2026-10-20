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
}

// The scopes of changes that are not the app: the try demo, the wire between processes, the
// atlas, the release pipeline, CI, tests and dependencies, and the scripts and harness adapters around the product. The chat
// view ships behind a flag, so anything scoped to it is never announced.
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

/** The chat view ships behind a flag, and the try demo is not the app: neither is announced. */
export const chat = /\bchats?\b/i
export const demo = /\bdemos?\b/i
const unannounced = (text: string): boolean => chat.test(text) || demo.test(text)

// A list item or a numbered one starts a block of its own.
const itemStart = /^\s*(?:[-*+]|\d+\.)\s/

/** The text under a pull request body's `## What` heading, up to the next heading. */
export const whatOf = (body: string): string => {
  const found = /^## What[ \t]*\r?\n(?<text>[\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)
  // The bodies are hard-wrapped, so a sentence runs over lines: join each paragraph or list
  // item before cutting into sentences, then drop the sentences that name what isn't announced.
  const blocks: string[] = []
  let open = false
  // Links are the pull request's business; a URL in what the model reads is a way to steer it.
  const plain = (found?.groups?.text ?? "")
    .replaceAll("\r", "")
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
        .filter((sentence) => !unannounced(sentence))
        .join(" ")
      // A block that was all about it goes whole; a blank line stays a blank line.
      return block && !kept ? [] : [kept]
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > maxWhat ? `${text.slice(0, maxWhat).trimEnd()}...` : text
}

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
  }
}

// What a revert says it undoes: the subject it quotes and the pull requests it names.
type Reverted = { readonly name: string | undefined; readonly prs: readonly number[] }

const withoutPr = (subject: string): string =>
  subject
    .replace(/ \(#\d+\)$/, "")
    .trim()
    .toLowerCase()

const revertOf = (raw: RawCommit): Reverted | undefined => {
  const subject = raw.subject.trim()
  const quoted = /^Revert "(?<inner>.+)"(?: \(#\d+\))?$/.exec(subject)?.groups?.["inner"]
  const typed = /^revert(?:\([^)]*\))?!?: (?<inner>.+)$/i.exec(subject)?.groups?.["inner"]
  const inner = quoted ?? typed
  if (!inner) return undefined
  // The revert's own number is the last in its subject; those inside the quote, and a body that
  // says "reverts #12", name the work undone.
  const named = quoted ? inner : inner.replace(/ \(#\d+\)$/, "")
  const prs = [
    ...[...named.matchAll(/#(\d+)/g)].map((found) => Number(found[1])),
    ...[...raw.body.matchAll(/\breverts?\b[^\n]*?#(\d+)/gi)].map((found) => Number(found[1])),
  ]
  return { name: withoutPr(named), prs }
}

/**
 * The user-visible commits of a range. A commit that a revert in the range undoes is left out
 * along with the revert, matched by the subject the revert quotes or a pull request it names.
 */
export const parseCommits = (raws: readonly RawCommit[]): Commit[] => {
  const reverts = raws.flatMap((raw) => revertOf(raw) ?? [])
  return raws.flatMap((raw) => {
    const commit = parseCommit(raw)
    if (!commit) return []
    const names = new Set([withoutPr(raw.subject), commit.subject.toLowerCase()])
    const undone = reverts.some(
      (revert) =>
        (revert.name !== undefined && names.has(revert.name)) ||
        (commit.pr !== undefined && revert.prs.includes(commit.pr)),
    )
    return undone ? [] : [commit]
  })
}
