import { readNotesBlock, type ReleaseNotes } from "../../contract/protocol/src/release-notes.ts"
import { checkOutput } from "./check.ts"
import { parseCommits } from "./commits.ts"
import { commitItem, type Item } from "./items.ts"
import { parseOutput, type Answer } from "./model.ts"
import { originalOf } from "./render.ts"
import { Skip, viaGh } from "./skip.ts"
import { type Sources } from "./sources.ts"

/** Asks the model about the items and returns its answer's text, or throws `Skip`. */
export type Ask = (
  kind: "release" | "promote",
  version: string,
  items: readonly Item[],
) => Promise<Answer>

export type Generated = {
  readonly notes: ReleaseNotes
  /** The changelog to keep under the notes. */
  readonly original: string
  /** A link to everything the notes cover, for a promotion. */
  readonly compare: string | undefined
  /** The model's answer as it came. */
  readonly raw: string
  readonly outputTokens: number
  /** The model that answered, as OpenRouter names it. */
  readonly model: string
  /** The lines the checks dropped, and why. */
  readonly dropped: readonly string[]
  /** How many items the model was asked about. */
  readonly considered: number
}

/** `[major, minor, patch]` of a `vX.Y.Z` tag, or `undefined` for any other tag. */
const versionOf = (tag: string): [number, number, number] | undefined => {
  const found = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined
}

const compare = (a: string, b: string): number => {
  const x = versionOf(a)!
  const y = versionOf(b)!
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Release tags among `tags`, oldest version first. */
const sorted = (tags: readonly string[]): string[] =>
  tags.filter((tag) => versionOf(tag)).toSorted(compare)

/**
 * The notes for these items, as the model wrote them and the checks left them. Throws
 * `Skip` when there is no answer to use; an answer of empty lists is an answer, of a
 * release with nothing to see.
 */
const compose = async (
  kind: "release" | "promote",
  tag: string,
  items: readonly Item[],
  ask: Ask,
): Promise<
  Pick<Generated, "notes" | "raw" | "outputTokens" | "model" | "dropped" | "considered">
> => {
  const version = tag.slice(1)
  // Only a change with a pull request can be cited, so only those are put to the model.
  const given = items.filter((item) => item.prs.length > 0)
  if (given.length === 0)
    return {
      notes: { version, kind, highlights: [], changes: [], fixes: 0 },
      raw: "(nothing was asked)",
      outputTokens: 0,
      model: "(none asked)",
      dropped: [],
      considered: given.length,
    }
  const { text, outputTokens, model } = await ask(kind, version, given)
  const output = parseOutput(text)
  const checked = checkOutput(output, kind, new Set(given.flatMap((item) => item.prs)))
  if (!checked.ok) throw new Skip(checked.reason, text)
  const { highlights } = checked.output
  // A change a highlight already tells is not told twice.
  const told = new Set(highlights.flatMap((highlight) => highlight.prs))
  const changes = checked.output.changes.filter((change) => !change.prs.every((pr) => told.has(pr)))
  const cited = new Set([...told, ...changes.flatMap((change) => change.prs)])
  const unnamed = given.filter((item) => item.fix && !item.prs.some((pr) => cited.has(pr))).length
  return {
    notes: { version, kind, highlights, changes, fixes: unnamed },
    raw: text,
    outputTokens,
    model,
    dropped: checked.dropped,
    considered: given.length,
  }
}

/**
 * A prerelease's notes: the commits since the release before it. Throws `Skip` when the
 * release should keep the body it has: it is no longer a prerelease, a promotion has already
 * written it, or the model gave nothing to use.
 */
export const generateRelease = async (
  tag: string,
  sources: Sources,
  ask: Ask,
): Promise<Generated> => {
  if (!versionOf(tag)) throw new Error(`${tag} is not a vX.Y.Z tag`)
  const tags = sorted(await sources.tags(tag))
  const at = tags.indexOf(tag)
  if (at < 0) throw new Error(`${tag} is not among the release tags merged into it`)
  const items = parseCommits(await sources.commits(tags[at - 1], tag)).map(commitItem)
  const release = await viaGh(`read ${tag}'s release`, sources.release(tag))
  if (!release) throw new Skip(`${tag} has no release to write notes on`)
  if (!release.prerelease) throw new Skip(`${tag} is no longer a prerelease`)
  if (readNotesBlock(release.body)?.kind === "promote")
    throw new Skip(`${tag}'s body is a promotion's notes, which a build's don't replace`)
  return {
    ...(await compose("release", tag, items, ask)),
    original: originalOf(release.body),
    compare: undefined,
  }
}

/**
 * A promotion's notes: every change since the latest stable one, up to `tag`. The details
 * keep only the promoted release's own changelog and a link to the whole range.
 */
export const generatePromote = async (
  tag: string,
  sources: Sources,
  ask: Ask,
  repo: string,
): Promise<Generated> => {
  if (!versionOf(tag)) throw new Error(`${tag} is not a vX.Y.Z tag`)
  const tags = sorted(await sources.tags(tag))
  if (!tags.includes(tag)) throw new Error(`${tag} is not among the release tags merged into it`)
  const stable = await viaGh("look up the latest stable release", sources.stable())
  if (stable && versionOf(stable) && compare(stable, tag) >= 0)
    throw new Skip(`${tag} is not newer than the stable release ${stable}`)
  const known = stable && versionOf(stable) ? stable : undefined
  // Every commit of the range goes to the model as it is, not through what a prerelease's
  // own run made of it: the model that picks the highlights judges every change itself.
  const items = parseCommits(await sources.commits(known, tag)).map(commitItem)
  const found = await viaGh(`read ${tag}'s release`, sources.release(tag))
  if (!found) throw new Skip(`${tag} has no release to write notes on`)
  const own = originalOf(found.body)
  return {
    ...(await compose("promote", tag, items, ask)),
    original: own,
    // Without a stable release there is no start to compare from, so the link is the history.
    compare: known
      ? `https://github.com/${repo}/compare/${known}...${tag}`
      : `https://github.com/${repo}/commits/${tag}`,
  }
}
