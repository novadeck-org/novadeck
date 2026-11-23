import { readFileSync } from "node:fs"
import { join } from "node:path"

import { type RawCommit } from "./commits.ts"

/** Where the list lives in the repository, as `git show <tag>:` reads it. */
export const experimentalPath = "scripts/release-notes/experimental.json"

/** A feature still behind Preferences > Experimental: its own commit scopes and code. */
export type Feature = {
  /** Commit scopes that are only about it: a commit in one is held back. */
  readonly scopes: readonly string[]
  /** Folders and files that are only about it, which Verify asks a pull request about. */
  readonly paths: readonly string[]
}

/** Each feature still behind Preferences > Experimental, by its row's id. */
export type Experimental = ReadonlyMap<string, Feature>

const words = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value) || !value.every((each) => typeof each === "string" && each !== ""))
    throw new Error(`${where} is not a list of words.`)
  return value
}

/**
 * The list from its file's text; throws on a file of the wrong shape. Plain checks, not a
 * schema library: Verify reads it too, on a runner that installs nothing.
 */
export const parseExperimental = (text: string): Experimental => {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null) throw new Error("The list is not an object.")
  const { why, features } = parsed as { why?: unknown; features?: unknown }
  if (typeof why !== "string") throw new Error(`The list has no "why".`)
  if (typeof features !== "object" || features === null || Array.isArray(features))
    throw new Error(`The list has no "features".`)
  return new Map(
    Object.entries(features).map(([id, feature]): [string, Feature] => {
      if (!/^[a-z][a-z-]*$/.test(id)) throw new Error(`"${id}" is not a row's id.`)
      if (typeof feature !== "object" || feature === null)
        throw new Error(`"${id}" is not an object.`)
      const { scopes, paths } = feature as { scopes?: unknown; paths?: unknown }
      return [id, { scopes: words(scopes, `${id}'s scopes`), paths: words(paths, `${id}'s paths`) }]
    }),
  )
}

/** The list as this checkout has it. */
export const checkoutExperimental = (): Experimental =>
  parseExperimental(readFileSync(join(import.meta.dirname, "experimental.json"), "utf8"))

/** The word a pull request gives for a change everyone sees, under a listed scope or not. */
export const forEveryone = "none"

/** A conventional subject's scopes: `fix(ui, works): …` → `["ui", "works"]`. */
export const scopesOf = (subject: string): string[] =>
  /^[a-z]+\((?<scope>[^)]*)\)!?: /
    .exec(subject.trim())
    ?.groups?.["scope"]?.split(",")
    .map((part) => part.trim()) ?? []

/** The ids a pull request body's `Experimental: <id>` lines name, `none` included. */
export const markersOf = (body: string): string[] =>
  [...body.matchAll(/^Experimental:[ \t]*(?<id>\S+)[ \t]*$/gim)].map((found) =>
    found.groups!["id"]!.toLowerCase(),
  )

/**
 * The listed feature a commit belongs to, or `undefined` when it is for everyone: by its scope,
 * or by an `Experimental: <id>` line in its body, unless that body says `Experimental: none`,
 * which a change people without the feature see too gives. A subject that only says "behind
 * Experimental" names no feature, so its hold could never lift; the prompt leaves those to the
 * model, which sees whether a later change in the range takes the feature out.
 */
export const heldFeature = (raw: RawCommit, experimental: Experimental): string | undefined => {
  const markers = markersOf(raw.body)
  if (markers.includes(forEveryone)) return undefined
  const scopes = scopesOf(raw.subject)
  for (const [id, { scopes: own }] of experimental)
    if (scopes.some((scope) => own.includes(scope))) return id
  return markers.find((id) => experimental.has(id))
}

/** The commits for everyone, and the ones held back with the feature each belongs to. */
export const holdBack = (
  raws: readonly RawCommit[],
  experimental: Experimental,
): { readonly kept: RawCommit[]; readonly held: { raw: RawCommit; feature: string }[] } => {
  const kept: RawCommit[] = []
  const held: { raw: RawCommit; feature: string }[] = []
  for (const raw of raws) {
    const feature = heldFeature(raw, experimental)
    if (feature) held.push({ raw, feature })
    else kept.push(raw)
  }
  return { kept, held }
}
