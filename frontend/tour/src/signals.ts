import { inboxType, type InboxState, type SettledHow } from "@novadeck/core/inbox"
import type { MessagesState } from "@novadeck/core/messages"
import type { TerminalMetadata, Workspace, WorkspaceProject } from "@novadeck/core/types"

// Where the tour's lead stands, as its terminal shows it:
// - `gone`: its terminal closed, which ends the tour.
// - `ended`: its process ended (exited or failed), as an agent not signed in may.
// - `starting`: a shell with no agent showing yet.
// - `screen`: the agent holds at one of its own screens first, for the person to answer:
//   folder trust and the like (`startup`), its sign-in, or Novadeck's hooks off (`hooks`).
// - `agent`: the agent is there (or resting, asleep, for a message to wake it), `working` on a
//   turn or not, `named` once it described itself (its terminal took a title of its agent's), and
//   `answered` once a turn of its ended.
export type LeadState =
  | { readonly kind: "gone" }
  | { readonly kind: "ended" }
  | { readonly kind: "starting" }
  | { readonly kind: "screen"; readonly screen: "startup" | "sign-in" | "hooks" }
  | {
      readonly kind: "agent"
      readonly working: boolean
      readonly named: boolean
      readonly answered: boolean
    }

// What the tour waits on, read from the workspace, the agents' messages and the Inbox: the
// signals its steps go by.
export type TourSignals = {
  readonly lead: LeadState
  // Whether the lead's project and session are the ones on screen: the tour shows only there.
  readonly onScreen: boolean
  // The teammates the lead opened (terminals it leads), and how many have named themselves.
  readonly team: { readonly count: number; readonly named: number }
  // Whether a teammate's question waits in the Inbox now, asked through Novadeck or its
  // harness's own question tool.
  readonly asking: boolean
  // The Inbox row of that question, for the stage to mark; null while none waits.
  readonly askingRow: string | null
  // Whether the person answered or dismissed a teammate's question: their answer is in the
  // teammate's messages, and its row stays in the Inbox, settled, both through a reload.
  readonly answered: boolean
  // A teammate holding at a screen of its own agent's, as its harness's folder trust, for the
  // person to answer in its terminal; null while none does.
  readonly teamScreen: {
    readonly terminalId: string
    readonly screen: "startup" | "sign-in" | "hooks"
    // Its harness, by the program it runs, where known: the screens' words differ by harness.
    readonly program: string | null
  } | null
  // An agent of the team (the lead or a teammate) waiting on the person's yes to something, as
  // its harness's own permission dialog, or a message held for them: an unsettled Inbox row of
  // type Unblock, whichever harness raised it. Null while none does.
  readonly permission: { readonly terminalId: string } | null
  // How many distinct teammates have sent the lead a message (their report that they're done).
  readonly reporters: number
  // The shell the person opened in the tour's project that no agent holds yet: not the lead, no
  // team's, nothing running in it; null while none is. The tour's second fixer starts there.
  readonly fresh: string | null
  // The merged preview of the tour's file (`split.js`) while it is open in the tour's project:
  // the window that shows it; null while it isn't.
  readonly preview: { readonly windowId: string } | null
}

// A file the person opened to preview what the agents' work merges to, as the app keeps it for
// the session it is open in: the project, the window's item, and the file's path.
export type TourPreview = {
  readonly projectId: string
  readonly itemId: string
  readonly path: string
}

// The file the tour has the person open, as its preview is the story's end.
export const tourFile = "split.js"

// What else the signals are read from, where the backend has it.
export type TourSources = {
  readonly messages?: MessagesState | undefined
  readonly inbox?: InboxState | undefined
  readonly previews?: readonly TourPreview[] | undefined
}

export const noTeam: Pick<
  TourSignals,
  | "team"
  | "asking"
  | "askingRow"
  | "answered"
  | "teamScreen"
  | "permission"
  | "reporters"
  | "fresh"
  | "preview"
> = {
  team: { count: 0, named: 0 },
  asking: false,
  askingRow: null,
  answered: false,
  teamScreen: null,
  permission: null,
  reporters: 0,
  fresh: null,
  preview: null,
}

// A process that ended; `finished` is a command that ran its course, its shell still there.
const ended: ReadonlySet<string> = new Set(["exited", "failed"])

// Where a terminal's agent stands, as `LeadState` says.
export const leadState = (terminal: TerminalMetadata | undefined): LeadState => {
  if (!terminal) return { kind: "gone" }
  if (ended.has(terminal.state)) return { kind: "ended" }
  const named = terminal.titleSource?.kind === "agent"
  if (terminal.state === "sleeping") return { kind: "agent", working: false, named, answered: true }
  if (terminal.state !== "running" || !terminal.agent) return { kind: "starting" }
  const { startup, working, lastTurn } = terminal.agent
  if (startup) return { kind: "screen", screen: startup }
  return { kind: "agent", working, named, answered: lastTurn !== undefined }
}

// Every message of the agents' threads, each once (a message shows in both ends' threads).
const everyMessage = (messages: MessagesState | undefined) => {
  const seen = new Map<
    string,
    MessagesState["terminals"][string]["threads"][number]["messages"][number]
  >()
  for (const terminal of Object.values(messages?.terminals ?? {}))
    for (const thread of terminal.threads)
      for (const message of thread.messages) seen.set(message.id, message)
  return [...seen.values()]
}

// How many distinct teammates sent the lead a message.
const reportersOf = (
  messages: MessagesState | undefined,
  teammates: ReadonlySet<string>,
  lead: string,
): number =>
  new Set(
    everyMessage(messages).flatMap(({ from, to }) =>
      from.kind === "agent" &&
      to.kind === "agent" &&
      to.terminalId === lead &&
      teammates.has(from.terminalId)
        ? [from.terminalId]
        : [],
    ),
  ).size

// The team's questions in the Inbox: its asks, or a harness's own question tool's (a request
// the Inbox lists as a question), whichever a teammate used.
const questionsOf = (inbox: InboxState | undefined, team: ReadonlySet<string>) =>
  (inbox?.items ?? []).filter((row) => inboxType(row) === "ask" && team.has(row.source.terminalId))

// How a question ends by the person's own doing: answered, in the Inbox or the terminal, or
// dismissed. Not one its agent's session took away (`ended`, `away`).
const byThePerson: ReadonlySet<SettledHow> = new Set([
  "answered",
  "terminal",
  "dismissed",
  "replied",
  "gone",
])

// Whether the person dealt with one of the team's questions: an Inbox answer delivered to it,
// which stays in its messages; or its row, settled by them, which the Inbox keeps as history.
const answeredOf = (
  messages: MessagesState | undefined,
  inbox: InboxState | undefined,
  team: ReadonlySet<string>,
): boolean =>
  everyMessage(messages).some(
    ({ inbox: kind, to }) => kind === "answer" && to.kind === "agent" && team.has(to.terminalId),
  ) || questionsOf(inbox, team).some((row) => row.settled && byThePerson.has(row.settled.how))

// The Inbox row of a question from the team that waits there, not one already settled.
const askingRowOf = (inbox: InboxState | undefined, team: ReadonlySet<string>): string | null =>
  questionsOf(inbox, team).find((row) => !row.settled)?.id ?? null

// The first of the team's agents waiting on the person's yes: an unsettled Unblock row.
const permissionOf = (
  inbox: InboxState | undefined,
  team: ReadonlySet<string>,
): TourSignals["permission"] => {
  const row = (inbox?.items ?? []).find(
    (each) => !each.settled && inboxType(each) === "unblock" && team.has(each.source.terminalId),
  )
  return row ? { terminalId: row.source.terminalId } : null
}

// The first shell of the project nobody has taken: not the lead, not led by anyone, no agent in it
// and none run there. In the tour's project the person opens one at the tour's prompt.
const freshShell = (history: WorkspaceProject["history"], lead: string): string | null => {
  for (const { state } of history)
    for (const each of state.roster.terminals)
      if (
        each.id !== lead &&
        !each.ledBy &&
        !each.agentRan &&
        (each.state === "idle" || (each.state === "running" && !each.agent))
      )
        return each.id
  return null
}

// The window that shows the tour's file merged, while its preview is open in the project.
const previewOf = (
  project: WorkspaceProject,
  previews: readonly TourPreview[] | undefined,
): TourSignals["preview"] => {
  for (const preview of previews ?? []) {
    if (preview.projectId !== project.id || preview.path.split("/").pop() !== tourFile) continue
    for (const { state } of project.history) {
      const window = state.roster.windows.find((each) => each.itemId === preview.itemId)
      if (window) return { windowId: window.id }
    }
  }
  return null
}

// The tour's signals, for its lead in `terminalId`.
export const tourSignals = (
  workspace: Workspace,
  terminalId: string,
  sources: TourSources = {},
): TourSignals => {
  for (const project of workspace.projects)
    for (const session of project.history) {
      const { terminals } = session.state.roster
      const terminal = terminals.find(({ id }) => id === terminalId)
      if (!terminal) continue
      // Teammates stay where they opened, in the lead's project, if moved to another session.
      const teammates = project.history.flatMap(({ state }) =>
        state.roster.terminals.filter(({ ledBy }) => ledBy === terminalId),
      )
      const mates = new Set(teammates.map(({ id }) => id))
      const team = new Set([terminalId, ...mates])
      const held = teammates
        .map((mate) => ({ mate, lead: leadState(mate) }))
        .find(({ lead }) => lead.kind === "screen")
      return {
        lead: leadState(terminal),
        onScreen:
          workspace.activeProjectId === project.id && project.activeSessionId === session.id,
        team: {
          count: teammates.length,
          named: teammates.filter(({ titleSource }) => titleSource?.kind === "agent").length,
        },
        // The teammates' questions only: one of the lead's own, as for something it lacks, isn't
        // the story's question.
        asking: askingRowOf(sources.inbox, mates) !== null,
        askingRow: askingRowOf(sources.inbox, mates),
        answered: answeredOf(sources.messages, sources.inbox, mates),
        teamScreen:
          held && held.lead.kind === "screen"
            ? {
                terminalId: held.mate.id,
                screen: held.lead.screen,
                program: held.mate.process ?? null,
              }
            : null,
        permission: permissionOf(sources.inbox, team),
        reporters: reportersOf(sources.messages, mates, terminalId),
        fresh: freshShell(project.history, terminalId),
        preview: previewOf(project, sources.previews),
      }
    }
  return { lead: { kind: "gone" }, onScreen: false, ...noTeam }
}

export const sameSignals = (a: TourSignals, b: TourSignals): boolean =>
  a.onScreen === b.onScreen &&
  a.asking === b.asking &&
  a.askingRow === b.askingRow &&
  a.answered === b.answered &&
  a.teamScreen?.terminalId === b.teamScreen?.terminalId &&
  a.teamScreen?.screen === b.teamScreen?.screen &&
  a.permission?.terminalId === b.permission?.terminalId &&
  a.reporters === b.reporters &&
  a.fresh === b.fresh &&
  a.preview?.windowId === b.preview?.windowId &&
  a.team.count === b.team.count &&
  a.team.named === b.team.named &&
  JSON.stringify(a.lead) === JSON.stringify(b.lead)
