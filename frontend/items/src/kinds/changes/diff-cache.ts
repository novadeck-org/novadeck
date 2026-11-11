import type { ChangeFileDiff } from "@novadeck/core/items"
import { factsOf, type Declaration, type FileFacts } from "@novadeck/viewers/facts"

// One file's diff for a selection of layers, with the facts read from its sides, kept by the
// change it was read from (the item and its stamp), the layers selected and the path, so the
// same question, asked again as the person steps back and forth, is not put to the backend
// again. A change that moves on has a new stamp and so new keys.

export type FileDiff = {
  readonly diff: ChangeFileDiff
  /** The facts of each run, null where its language gives none or the text was not sent. */
  readonly facts: readonly (FileFacts | null)[]
}

type Cache = {
  readonly kept: Map<string, FileDiff>
  readonly asked: Map<string, Promise<FileDiff>>
}
const keptMost = 200

// Each backend's, which the item store of a session stands for: one that goes takes its cache.
const caches = new WeakMap<object, Cache>()
const cacheOf = (scope: object): Cache => {
  const known = caches.get(scope)
  if (known) return known
  const made = { kept: new Map<string, FileDiff>(), asked: new Map<string, Promise<FileDiff>>() }
  caches.set(scope, made)
  return made
}

const keyOf = (itemId: string, stamp: string, layers: readonly string[], path: string): string =>
  [itemId, stamp, layers.join(","), path].join("\0")

/** What is known of the file already, if anything. */
export const peekDiff = (
  scope: object,
  itemId: string,
  stamp: string,
  layers: readonly string[],
  path: string,
): FileDiff | undefined => cacheOf(scope).kept.get(keyOf(itemId, stamp, layers, path))

// A declaration's text told which changed; it is not kept.
const bare = (list: readonly Declaration[]) => list.map((each) => ({ ...each, body: "" }))

const factsOfRun = async (run: ChangeFileDiff["runs"][number]): Promise<FileFacts | null> => {
  // Without a side's text, or past the bounds, a change is only its lines.
  if (run.big || run.hunks.length === 0) return null
  try {
    const facts = await factsOf({
      path: run.file.path,
      before: run.before,
      after: run.after,
      hunks: run.hunks,
    })
    if (!facts) return null
    const { added, removed, changed } = facts.declarations
    return {
      ...facts,
      declarations: { added: bare(added), removed: bare(removed), changed: bare(changed) },
    }
  } catch {
    return null
  }
}

/** The file's diff for the layers, from the cache or read by `read`; a failure is not kept. */
export const loadDiff = (
  scope: object,
  itemId: string,
  stamp: string,
  layers: readonly string[],
  path: string,
  read: () => Promise<ChangeFileDiff>,
): Promise<FileDiff> => {
  const { kept, asked } = cacheOf(scope)
  const key = keyOf(itemId, stamp, layers, path)
  const known = kept.get(key)
  if (known) return Promise.resolve(known)
  const pending = asked.get(key)
  if (pending) return pending
  const loading = read()
    .then(async (diff): Promise<FileDiff> => {
      const loaded = { diff, facts: await Promise.all(diff.runs.map(factsOfRun)) }
      // The same question at an older stamp is not asked again: its answer goes.
      const [, , same, name] = key.split("\0")
      for (const old of kept.keys()) {
        const [oldItem, , oldLayers, oldPath] = old.split("\0")
        if (oldItem === itemId && oldLayers === same && oldPath === name) kept.delete(old)
      }
      kept.set(key, loaded)
      for (const old of kept.keys()) {
        if (kept.size <= keptMost) break
        kept.delete(old)
      }
      return loaded
    })
    .finally(() => asked.delete(key))
  asked.set(key, loading)
  return loading
}
