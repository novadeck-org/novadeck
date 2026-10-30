import { notesIn, type PlanVersion } from "@novadeck/core/items"

import { eolOf, lf, type PlanDoc } from "../kinds/plan/plan-doc"

// What the plan becomes when its file changed under it. Pure: the merge code is given, as
// the store loads it only when a plan changes.

type Sync = typeof import("@novadeck/viewers/sync")

// The plan with the agent's rewrite taken in. `echo` says the rewrite is the person's own
// save reported back; `unconfirmed` are the texts sent in saves whose answer never came.
export const rewritten = (
  plan: PlanDoc,
  { stamp, plan: incoming }: PlanVersion,
  echo: boolean,
  unconfirmed: readonly string[],
  { distance, merge }: Sync,
): PlanDoc => {
  const theirs = lf(incoming.text)
  const facts = {
    writable: incoming.writable,
    skill: incoming.skill,
    truncated: incoming.truncated,
  }
  if (
    stamp === plan.revision &&
    theirs === plan.base &&
    incoming.writable === plan.writable &&
    incoming.skill === plan.skill &&
    incoming.truncated === plan.truncated
  )
    return plan
  // A backend watching the file reports the person's own save back.
  if (echo || theirs === plan.text)
    return { ...plan, ...facts, base: theirs, revision: stamp, eol: eolOf(incoming.text) }
  // A save whose answer never came may have been written: the rewrite merges over
  // whichever the file now stands closest to, so a written save's edits aren't
  // merged in twice and an unwritten one's aren't taken for the agent's.
  const base = [plan.base, ...unconfirmed].reduce((closest, candidate) =>
    distance(candidate, theirs) < distance(closest, theirs) ? candidate : closest,
  )
  const written = merge(base, plan.text, theirs)
  return {
    ...plan,
    ...facts,
    base: theirs,
    revision: stamp,
    eol: eolOf(incoming.text),
    text: written.text,
    marks: written.changed,
    marked: written.text,
    changes: written.changes,
    showChanges: true,
    resolved: Math.max(0, notesIn(plan.text) - notesIn(written.text)),
  }
}
