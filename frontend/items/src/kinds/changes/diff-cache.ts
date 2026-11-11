import type { ChangeFileDiff } from "@novadeck/core/items"
import { factsOf, type Declaration, type FileFacts } from "@novadeck/viewers/facts"

import { answersIn } from "./answers"

// One file's diff for a selection of layers, with the facts read from its sides, kept by the
// change it was read from (the item and its stamp), the layers selected and the path (see
// ./answers.ts).

export type FileDiff = {
  readonly diff: ChangeFileDiff
  /** The facts of the run, null where its language gives none or the text was not sent. */
  readonly facts: FileFacts | null
}

// Each backend's, which the item store of a session stands for.
const diffs = answersIn<FileDiff>(200)

const familyOf = (itemId: string, layers: readonly string[], path: string): string =>
  [itemId, layers.join(","), path].join("\0")

/** What is known of the file at this stamp already, if anything. */
export const peekDiff = (
  scope: object,
  itemId: string,
  stamp: string,
  layers: readonly string[],
  path: string,
): FileDiff | undefined => diffs(scope).peek(familyOf(itemId, layers, path), stamp)

// A declaration's text told which changed; it is not kept.
const bare = (list: readonly Declaration[]) => list.map((each) => ({ ...each, body: "" }))

const factsOfRun = async (run: NonNullable<ChangeFileDiff["run"]>): Promise<FileFacts | null> => {
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
): Promise<FileDiff> =>
  diffs(scope).load(familyOf(itemId, layers, path), stamp, () => readDiff(read))

/** The diff, and the facts read from its sides. */
export const readDiff = async (read: () => Promise<ChangeFileDiff>): Promise<FileDiff> => {
  const diff = await read()
  return { diff, facts: diff.run ? await factsOfRun(diff.run) : null }
}

/** The answers of file diffs and their family of a question, for `useFileDiff`. */
export const fileDiffs = diffs
export const diffFamily = familyOf
