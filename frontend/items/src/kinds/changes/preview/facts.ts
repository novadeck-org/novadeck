import { factsOf, type FactHunk, type FileFacts } from "@novadeck/viewers/facts"

import { linesOf, type Agent } from "./layout"

// What an agent's changes to a file are said to be, by the same facts the diff pane gives: its
// changes (those that apply) as hunks of main's lines, and the file with them made.

/** The agent's changes that apply as hunks of main's text, and the text with them made. */
export const factHunks = (
  main: string | null,
  agent: Pick<Agent, "hunks">,
): { readonly after: string; readonly hunks: FactHunk[] } => {
  const lines = linesOf(main)
  const after: string[] = []
  const hunks: FactHunk[] = []
  let taken = 0
  for (const hunk of agent.hunks.filter((each) => each.applies)) {
    after.push(...lines.slice(taken, hunk.at - 1))
    const newStart = after.length + 1
    after.push(...hunk.lines)
    taken = hunk.at - 1 + hunk.removed
    hunks.push({
      oldStart: hunk.removed > 0 ? hunk.at : hunk.at - 1,
      oldCount: hunk.removed,
      newStart: hunk.lines.length > 0 ? newStart : newStart - 1,
      newCount: hunk.lines.length,
      lines: [
        ...lines
          .slice(hunk.at - 1, hunk.at - 1 + hunk.removed)
          .map((text) => ({ kind: "remove" as const, text })),
        ...hunk.lines.map((text) => ({ kind: "add" as const, text })),
      ],
    })
  }
  after.push(...lines.slice(taken))
  return { after: after.join("\n") + (after.length > 0 ? "\n" : ""), hunks }
}

/** The facts of each agent's changes, by key; null where the file's language gives none. */
export const factsOfAgents = async (
  path: string,
  main: string | null,
  agents: readonly Agent[],
): Promise<ReadonlyMap<string, FileFacts | null>> =>
  new Map(
    await Promise.all(
      agents.map(async (agent) => {
        const { after, hunks } = factHunks(main, agent)
        if (hunks.length === 0) return [agent.key, null] as const
        try {
          return [agent.key, await factsOf({ path, before: main, after, hunks })] as const
        } catch {
          return [agent.key, null] as const
        }
      }),
    ),
  )
