import type { AgentName } from "./harnesses"
import type { InboxRow } from "./inbox"
import type { Item, ItemContent } from "./items"
import type { Workspace, WorkspaceTarget } from "./types"

// The plan a plan approval in the Inbox asks the person to approve, for its sheet. No
// harness puts the plan in the dialog: each shows it as the asking terminal's plan item
// (see the runner's companions), which the sheet reads as the plan pane does. Claude Code's
// is the file ExitPlanMode names, or the text it passed; Codex's the plan its rollout
// records; Antigravity's the Markdown artifact it wrote for review.

// How long before its dialog each harness shows the plan the dialog asks about: Claude Code
// in the dialog's own hook, so not before it; Codex as its turn's last item, just before the
// dialog takes the screen; Antigravity as it writes the artifact, which its turn may go on
// past before the review shows. A plan item shown longer before is an earlier round's, as
// one the person sent back, whose plan the agent is still rewriting.
export const planLeadMs: Readonly<Record<AgentName, number>> = {
  claude: 1000,
  codex: 60_000,
  agy: 15 * 60_000,
}

// How long after its dialog a plan may still come: the hook or rollout line that shows it
// can reach the UI after the dialog does.
export const planWaitMs = 5000

// The plan item a plan approval asks about: found, still to come (until `until`), or none,
// for an item that is no plan approval or whose plan never came.
export type PlanPick =
  | { readonly state: "found"; readonly item: Item }
  | { readonly state: "waiting"; readonly until: number }
  | { readonly state: "none" }

const none: PlanPick = { state: "none" }

const noItems: readonly Item[] = []

// The items of the session an Inbox item's terminal is in: the session's own list, the same
// while it doesn't change, so a component can subscribe to it.
export const sessionItems = (workspace: Workspace, target: WorkspaceTarget): readonly Item[] =>
  workspace.projects
    .find((project) => project.id === target.projectId)
    ?.history.find((session) => session.id === target.workspaceSessionId)?.state.items ?? noItems

// The plan `row` asks the person to approve, among its session's items: the asking actor's
// (the root's, or a subagent's), on its terminal's bar or undocked from it, shown no longer
// before the dialog than its harness shows one, the latest of them. Hidden from the bar it
// is still there. `now` says whether one may yet come.
export const planItemOf = (
  items: readonly Item[],
  row: InboxRow,
  now: number,
  // Plan versions (`planKey`) another plan approval was answered with: one is never a later
  // round's plan, so a sent-back round's text isn't shown for the next while the new version
  // is on its way.
  used: ReadonlySet<string> = new Set(),
): PlanPick => {
  if (row.kind !== "request" || row.request.kind !== "plan") return none
  const { terminalId, agent } = row.source
  const role = row.request.subagent ? "subagent" : "root"
  const since = row.at - planLeadMs[agent]
  const found = items
    .filter(
      (item) =>
        item.kind === "plan" &&
        item.plan?.role === role &&
        // Shown from this terminal, wherever it sits now: a plan docked here from another
        // terminal is that terminal's.
        item.from?.terminalId === terminalId &&
        item.shownAt >= since,
    )
    .reduce<Item | undefined>(
      (latest, item) => (latest && latest.shownAt >= item.shownAt ? latest : item),
      undefined,
    )
  if (found && !used.has(planKey(found))) return { state: "found", item: found }
  const until = row.at + planWaitMs
  return now < until ? { state: "waiting", until } : none
}

// A plan item's version, which one plan approval shows.
export const planKey = (item: Pick<Item, "id" | "version">): string => `${item.id}:${item.version}`

// What a plan item's content gives the sheet: its Markdown, undefined while it loads, null
// where it can't be read. A plan cut short says so at its end, as the plan pane does.
export const planTextOf = (content: ItemContent | undefined): string | null | undefined => {
  if (!content) return undefined
  if (content.state !== "ready" || content.content.kind !== "plan") return null
  const { text, truncated } = content.content
  return truncated ? `${text}\n\n*It's long, so only its start is shown.*` : text
}
