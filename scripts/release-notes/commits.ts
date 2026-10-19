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
// atlas, the release pipeline, CI and the scripts and harness adapters around the product. The chat
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
])

const conventional =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?: (?<subject>.+?)(?: \(#(?<pr>\d+)\))?$/

/** The longest `## What` handed to the model: a pull request's own words, not its essay. */
export const maxWhat = 700

/** The text under a pull request body's `## What` heading, up to the next heading. */
export const whatOf = (body: string): string => {
  const found = /^## What[ \t]*\r?\n(?<text>[\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)
  const text = (found?.groups?.text ?? "")
    .replaceAll("\r", "")
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

export const parseCommits = (raws: readonly RawCommit[]): Commit[] =>
  raws.flatMap((raw) => parseCommit(raw) ?? [])
