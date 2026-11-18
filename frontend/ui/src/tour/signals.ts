import { inboxType, type InboxState, type SettledHow } from "@novadeck/core/inbox"
import type { MessagesState } from "@novadeck/core/messages"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

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
  // How many messages the teammates have sent, to one another or to the lead: the lead's own
  // to them (as `open_agent` sends each its task) aren't their talk.
  readonly talks: number
  // Whether a teammate's question waits in the Inbox now, asked through Novadeck or its
  // harness's own question tool.
  readonly asking: boolean
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
  // Whether the lead has shown its brief's card: an image (the card is an SVG), or a page or
  // file.
  readonly shown: boolean
}

// What else the signals are read from, where the backend has it.
export type TourSources = {
  readonly messages?: MessagesState | undefined
  readonly inbox?: InboxState | undefined
}

export const noTeam: Pick<
  TourSignals,
  "team" | "talks" | "asking" | "answered" | "teamScreen" | "permission" | "shown"
> = {
  team: { count: 0, named: 0 },
  talks: 0,
  asking: false,
  answered: false,
  teamScreen: null,
  permission: null,
  shown: false,
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

// How many messages the teammates sent to the team, the lead's own to them aside.
const talksOf = (
  messages: MessagesState | undefined,
  teammates: ReadonlySet<string>,
  team: ReadonlySet<string>,
): number =>
  everyMessage(messages).filter(
    ({ from, to }) =>
      from.kind === "agent" &&
      to.kind === "agent" &&
      from.terminalId !== to.terminalId &&
      teammates.has(from.terminalId) &&
      team.has(to.terminalId),
  ).length

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

// Whether a question from the team waits in the Inbox, not one already settled.
const askingOf = (inbox: InboxState | undefined, team: ReadonlySet<string>): boolean =>
  questionsOf(inbox, team).some((row) => !row.settled)

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
        talks: talksOf(sources.messages, mates, team),
        // The teammates' questions only: one of the lead's own, as for something it lacks, isn't
        // the story's question.
        asking: askingOf(sources.inbox, mates),
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
        shown: project.history.some(({ state }) =>
          state.items.some(
            (item) =>
              item.by === "agent" &&
              (item.kind === "image" ||
                item.kind === "video" ||
                item.kind === "audio" ||
                item.kind === "pdf" ||
                item.kind === "page" ||
                item.kind === "file") &&
              item.from?.terminalId === terminalId,
          ),
        ),
      }
    }
  return { lead: { kind: "gone" }, onScreen: false, ...noTeam }
}

export const sameSignals = (a: TourSignals, b: TourSignals): boolean =>
  a.onScreen === b.onScreen &&
  a.talks === b.talks &&
  a.asking === b.asking &&
  a.answered === b.answered &&
  a.teamScreen?.terminalId === b.teamScreen?.terminalId &&
  a.teamScreen?.screen === b.teamScreen?.screen &&
  a.permission?.terminalId === b.permission?.terminalId &&
  a.shown === b.shown &&
  a.team.count === b.team.count &&
  a.team.named === b.team.named &&
  JSON.stringify(a.lead) === JSON.stringify(b.lead)
