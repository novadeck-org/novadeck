import { readFileSync } from "node:fs"
import { join } from "node:path"

import { z } from "zod"

import { type RawCommit } from "./commits.ts"

/** Where the list lives in the repository, as `git show <tag>:` reads it. */
export const experimentalPath = "scripts/release-notes/experimental.json"

/** Each feature still behind Preferences > Experimental, by its row's id, with its own scopes. */
export type Experimental = ReadonlyMap<string, readonly string[]>

const shape = z.object({
  why: z.string(),
  features: z.record(z.string().regex(/^[a-z][a-z-]*$/), z.array(z.string().min(1))),
})

/** The list from its file's text; throws on a file of the wrong shape. */
export const parseExperimental = (text: string): Experimental =>
  new Map(Object.entries(shape.parse(JSON.parse(text)).features))

/** The list as this checkout has it. */
export const checkoutExperimental = (): Experimental =>
  parseExperimental(readFileSync(join(import.meta.dirname, "experimental.json"), "utf8"))

const scoped = /^[a-z]+\((?<scope>[^)]*)\)!?: /
// A pull request's own word that it belongs to a listed feature: `Experimental: tour`.
const marker = /^Experimental:[ \t]*(?<id>[a-z][a-z-]*)[ \t]*$/gim

/**
 * The listed feature a commit belongs to, or `undefined` when it is for everyone: by its scope,
 * or by an `Experimental: <id>` line in its body. A subject that only says "behind Experimental"
 * names no feature, so its hold could never lift; the prompt leaves those to the model, which
 * sees whether a later change in the range takes the feature out.
 */
export const heldFeature = (raw: RawCommit, experimental: Experimental): string | undefined => {
  const scopes =
    scoped
      .exec(raw.subject.trim())
      ?.groups?.["scope"]?.split(",")
      .map((part) => part.trim()) ?? []
  for (const [id, own] of experimental) if (scopes.some((scope) => own.includes(scope))) return id
  for (const found of raw.body.matchAll(marker)) {
    const id = found.groups!["id"]!
    if (experimental.has(id)) return id
  }
  return undefined
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
