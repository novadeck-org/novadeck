import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { makeGitSources, markerPrefix, newestRelease, refOf } from "../release-notes/sources.ts"

const run = promisify(execFile)

const usage = "Usage: main.ts [version | --newest | --base]"

type Version = readonly [number, number, number]
type Level = "major" | "minor" | "patch"

/** `[major, minor, patch]` of `X.Y.Z` or `vX.Y.Z`, or `undefined` for anything else. */
const parse = (value: string): Version | undefined => {
  const found = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const bump = ([major, minor, patch]: Version, level: Level): Version =>
  level === "major"
    ? [major + 1, 0, 0]
    : level === "minor"
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1]

/** Everything the plan reads from outside, behind functions so tests run offline. */
export type Sources = {
  /**
   * Every `vX.Y.Z` tag on main, in any order; tags of another shape are ignored. A
   * `release-base/vX.Y.Z` marker (see `markerPrefix`) counts as its `vX.Y.Z`.
   */
  readonly tags: () => Promise<string[]>
  /** Whether the repository has any release on GitHub, a draft or prerelease included. */
  readonly anyRelease: () => Promise<boolean>
  /** The tag of the latest stable release, or `undefined` before there is one. */
  readonly stable: () => Promise<string | undefined>
  /**
   * release-it's next version: the newest tag raised by what the commits since `from` (the
   * newest tag when `undefined`) call for, or `undefined` when none of them publishes a release.
   */
  readonly recommend: (from: string | undefined) => Promise<string | undefined>
}

export const commandSources = (cwd?: string): Sources => {
  const git = makeGitSources(cwd)
  return {
    tags: () => git.tags("HEAD"),
    anyRelease: async () => {
      const { stdout } = await run("gh", ["release", "list", "--limit", "1", "--json", "tagName"])
      return (JSON.parse(stdout) as unknown[]).length > 0
    },
    stable: git.stable,
    recommend: async (from) => {
      // release-it finds its newest tag with `git describe`, which reads no marker as one and
      // may stop at an older tag that history kept. When the newest release is a marker it is
      // told which, and to name its tags the same way.
      const base = await newestRelease(cwd)
      const markers =
        base && base.ref !== base.tag
          ? [`--git.tagName=${markerPrefix}v\${version}`, `--git.tagMatch=${base.ref}`]
          : []
      const { stdout } = await run(
        "pnpm",
        [
          "exec",
          "release-it",
          "--release-version",
          "--no-github.release",
          ...markers,
          ...(from
            ? [
                `--plugins.@release-it/conventional-changelog.commitsOpts.from=${await refOf(from, cwd)}`,
              ]
            : []),
        ],
        { cwd },
      )
      return stdout.trim() || undefined
    },
  }
}

/**
 * The version to release main as, or `undefined` when nothing since the newest release
 * publishes one (see .release-it.json for the types that do).
 *
 * Versions count from the latest stable release: the commits since it decide whether the next
 * stable one is a major, minor or patch release, and the first prerelease after it takes that
 * version. Every later prerelease takes the next patch, until a commit calls for more than the
 * cycle has: after stable 1.0.0, a `feat` makes 1.1.0, fixes 1.1.1 and 1.1.2, a breaking change
 * 2.0.0. Whichever prerelease is promoted, the stable release a minor one brings ends in some
 * patch, as 1.1.2. Before the first stable release every prerelease takes the next patch.
 *
 * `requested`, `X.Y.Z` or `vX.Y.Z`, releases main as that version, whatever its commits call
 * for, as for the jump to 1.0.0; it must be newer than every release.
 */
export const planVersion = async (
  requested: string | undefined,
  sources: Sources,
): Promise<string | undefined> => {
  const tagged = await sources.tags()
  const newest = tagged
    .map(parse)
    .filter((version) => version !== undefined)
    .toSorted(compare)
    .at(-1)
  // Releases that leave no tag on main mean history was replaced without markers; planning on
  // would count from zero, or from commits that were released long ago.
  if (!newest && (await sources.anyRelease()))
    throw new Error(
      `GitHub has releases, but no vX.Y.Z tag or ${markerPrefix}vX.Y.Z marker is an ancestor of HEAD. Create the markers for the newest release and the latest stable one on main's commits, or fetch the tags.`,
    )
  // Whatever is planned counts from the latest stable release, so it has to be on main.
  const requireStable = (stableTag: string | undefined) => {
    if (stableTag && parse(stableTag) && !tagged.includes(stableTag))
      throw new Error(
        `The latest stable release ${stableTag} is not an ancestor of HEAD, and has no ${markerPrefix}${stableTag} marker.`,
      )
  }
  if (requested) {
    requireStable(await sources.stable())
    const wanted = parse(requested)
    if (!wanted) throw new Error(`'${requested}' is not a version like 1.2.3.`)
    if (newest && compare(wanted, newest) <= 0)
      throw new Error(
        `${wanted.join(".")} is not newer than the newest release, ${newest.join(".")}.`,
      )
    return wanted.join(".")
  }
  const recommended = await sources.recommend(undefined)
  if (!recommended || !newest) return recommended
  const stableTag = await sources.stable()
  requireStable(stableTag)
  const stable = stableTag ? parse(stableTag) : undefined
  if (!stableTag || !stable) return bump(newest, "patch").join(".")
  // release-it raises the newest tag, so the step it took names the level.
  const raised = parse((await sources.recommend(stableTag)) ?? "")
  const level: Level = !raised
    ? "patch"
    : raised[0] > newest[0]
      ? "major"
      : raised[1] > newest[1]
        ? "minor"
        : "patch"
  const target = bump(stable, level)
  return (compare(target, newest) > 0 ? target : bump(newest, "patch")).join(".")
}

/**
 * `node scripts/release-version/main.ts [version]`: prints the version to release main as, or
 * nothing when there is nothing to release; see `planVersion`. GH_TOKEN and GH_REPO are `gh`'s,
 * for the latest stable release.
 */
export const main = async (
  args = process.argv.slice(2),
  sources: Sources = commandSources(),
  log: (message: string) => void = console.log,
): Promise<void> => {
  if (args.length > 1) throw new Error(usage)
  if (args[0] === "--newest" || args[0] === "--base") {
    const newest = await newestRelease()
    // The tag of the newest release, or the marker to read it from when that is not a tag.
    const printed =
      args[0] === "--newest" ? newest?.tag : newest?.ref !== newest?.tag && newest?.ref
    if (printed) log(printed)
    return
  }
  const version = await planVersion(args[0] || undefined, sources)
  if (version) log(version)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
