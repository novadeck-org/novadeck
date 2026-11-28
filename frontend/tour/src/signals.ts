import { inboxType, type InboxState, type SettledHow } from "@novadeck/core/inbox"
import { isOnBar, type Item, type ItemId, type ItemKind } from "@novadeck/core/items"
import { messagesKey, topOf } from "@novadeck/core/items/companion-bar"
import type { MessagesState } from "@novadeck/core/messages"
import type { Approval } from "@novadeck/core/port"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { Work } from "@novadeck/core/works"

// Where the tour's lead stands, as its terminal shows it:
// - `gone`: its terminal closed, which ends the tour.
// - `ended`: its process ended (exited or failed), as an agent not signed in may.
// - `starting`: a shell with no agent showing yet.
// - `left`: its agent ran and the program has ended, its shell back at the prompt (as Claude Code
//   does where the folder isn't trusted): not a shell still to start its agent.
// - `screen`: the agent holds at one of its own screens first, for the person to answer:
//   folder trust and the like (`startup`), its sign-in, or Novadeck's hooks off (`hooks`).
// - `agent`: the agent is there (or resting, asleep, for a message to wake it), `working` on a
//   turn or not, `named` once it described itself (its terminal took a title of its agent's), and
//   `answered` once a turn of its ended.
export type LeadState =
  | { readonly kind: "gone" }
  | { readonly kind: "ended" }
  | { readonly kind: "starting" }
  | { readonly kind: "left" }
  | { readonly kind: "screen"; readonly screen: "startup" | "sign-in" | "hooks" }
  | {
      readonly kind: "agent"
      readonly working: boolean
      readonly named: boolean
      readonly answered: boolean
    }

// The parts the story casts by what they do, never by title: the lead, and among the teammates it
// opens (any number, in the order they came up) the one to ring when the story waits on them
// (`mate`: a quiet one that hasn't said it is polished), the first to write to another teammate
// (`talker`) and the one with a model (`maker`: it showed one, or its work changes the models).
export type TourRole = "lead" | "mate" | "talker" | "maker"

// The folder a teammate's models are written in, as the lead's plan names it.
export const modelsFolder = "models/"

// What a teammate writes the lead as its work comes along, as its task words it ("<Role>: first
// version in", "<Role>: polished"): right after the role's colon, so a message that only mentions
// polishing to come ("first version in, polished once World lands") counts as no more than it is.
const firstVersionNote = /^[^:\n]{1,40}:\s*first version/i
const polishedNote = /^[^:\n]{1,40}:\s*polished\b/i

// The tabs a step looks at in a pane.
export type PaneTab = "messages" | "page" | "model"

// What the tour waits on, read from the workspace, the agents' messages and the Inbox: the
// signals its steps go by. Every one that says something happened stays true once it has, as the
// agents may be faster than the narration.
export type TourSignals = {
  readonly lead: LeadState
  // Whether the lead's project and session are the ones on screen: the tour shows only there.
  readonly onScreen: boolean
  // The terminals of the roles found so far, which the stage marks and the nudges go to. The
  // lead's is the run's; a teammate is cast by what it did, never by its title (it has none
  // until it describes itself).
  readonly roles: Readonly<Partial<Record<TourRole, string>>>
  // The teammates the lead opened (terminals it leads), how many have named themselves, and their
  // terminals. A shell the lead opened for the game's server is none of them.
  readonly team: {
    readonly count: number
    readonly named: number
    readonly ids: readonly string[]
    // How many have told the lead their first version is in, and how many that it is polished
    // (all of them where the backend has no messages to read), and whether any is at work on a
    // turn now.
    readonly firstIn: number
    readonly polished: number
    readonly working: boolean
    // Whether any has asked the person a question of its own, answered or not.
    readonly asked: boolean
  }
  // Whether the lead's request to run a command in a new terminal waits for the person's yes.
  readonly approving: boolean
  // Whether the lead's command was allowed to run (it opened a terminal of its own, which is no
  // teammate) or its page is shown.
  readonly served: boolean
  // The lead's own question to the person, its sheet of what game to build: whether it waits in
  // the Inbox now, its row there for the stage to mark (null while none waits), and whether the
  // person answered or dismissed it: their answer is in the lead's messages, and its entry stays
  // in the Inbox, settled, both through a reload.
  readonly sheet: {
    readonly asking: boolean
    readonly row: string | null
    readonly answered: boolean
  }
  // The Inbox row of a teammate's own question to the person, asked through Novadeck or its
  // harness's own question tool, which the tour points at until it is answered, whatever the
  // step; null while none waits.
  readonly askingRow: string | null
  // A teammate holding at a screen of its own agent's, as its harness's folder trust, for the
  // person to answer in its terminal; null while none does.
  readonly teamScreen: {
    readonly terminalId: string
    readonly screen: "startup" | "sign-in" | "hooks"
    // Its harness, by the program it runs, where known: the screens' words differ by harness.
    readonly program: string | null
  } | null
  // A teammate whose agent left, its shell back, for the person to deal with in its terminal;
  // null while none has.
  readonly teamLeft: { readonly terminalId: string } | null
  // An agent of the story (the lead or a teammate) waiting on the person's yes to
  // something, as its harness's own permission dialog, or a message held for them: an unsettled
  // Inbox entry of type Unblock, whichever harness raised it. Null while none does.
  readonly permission: { readonly terminalId: string } | null
  // The items agents showed, by role: the id of the lead's page and the maker's model, each
  // null until it is on that agent's bar.
  readonly shown: {
    readonly page: ItemId | null
    readonly model: ItemId | null
  }
  // What each role's companion pane shows now: the tab at the top of its open pane, named by what
  // it is (Messages, or the item a step is about); null while the pane is shut or shows another.
  readonly open: Readonly<Partial<Record<TourRole, PaneTab | null>>>
  // Where each teammate role stands, once found: a step waiting on one counts it only while it
  // is there and quiet.
  readonly mates: Readonly<Partial<Record<Exclude<TourRole, "lead">, LeadState>>>
}

// What else the signals are read from, where the backend has it.
export type TourSources = {
  readonly messages?: MessagesState | undefined
  readonly inbox?: InboxState | undefined
  // Every work the backend tracks, where it has them.
  readonly works?: readonly Work[] | undefined
  // The approvals waiting on the person, where the backend asks for any.
  readonly approvals?: readonly Approval[] | undefined
}

export const noTeam: Pick<
  TourSignals,
  | "roles"
  | "team"
  | "approving"
  | "served"
  | "sheet"
  | "askingRow"
  | "teamScreen"
  | "teamLeft"
  | "permission"
  | "shown"
  | "open"
  | "mates"
> = {
  roles: {},
  team: { count: 0, named: 0, ids: [], firstIn: 0, polished: 0, working: false, asked: false },
  approving: false,
  served: false,
  sheet: { asking: false, row: null, answered: false },
  askingRow: null,
  teamScreen: null,
  teamLeft: null,
  permission: null,
  shown: { page: null, model: null },
  open: {},
  mates: {},
}

// A process that ended; `finished` is a command that ran its course, its shell still there.
const ended: ReadonlySet<string> = new Set(["exited", "failed"])

// Where a terminal's agent stands, as `LeadState` says.
export const leadState = (terminal: TerminalMetadata | undefined): LeadState => {
  if (!terminal) return { kind: "gone" }
  if (ended.has(terminal.state)) return { kind: "ended" }
  const named = terminal.titleSource?.kind === "agent"
  if (terminal.state === "sleeping") return { kind: "agent", working: false, named, answered: true }
  // An agent ran here and none is now, with the shell still there: the program ended. A shell
  // whose command hasn't run yet has no agent run, so it is only starting.
  if (terminal.agentRan && (terminal.state !== "running" || !terminal.agent)) {
    if (terminal.state === "idle" || terminal.state === "running" || terminal.state === "finished")
      return { kind: "left" }
  }
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

// Whether `from` wrote to `to` words that match `note`, in the agents' threads.
const wrote = (
  messages: MessagesState | undefined,
  from: string,
  to: string,
  note: RegExp,
): boolean =>
  everyMessage(messages).some(
    (message) =>
      message.from.kind === "agent" &&
      message.from.terminalId === from &&
      message.to.kind === "agent" &&
      message.to.terminalId === to &&
      note.test(message.text),
  )

// The teammate that first wrote to another teammate, not to the lead: the one the story shows
// talking to the rest. Null while none has.
const talkerOf = (
  messages: MessagesState | undefined,
  mates: ReadonlySet<string>,
): string | null => {
  let first: { readonly id: string; readonly at: number } | null = null
  for (const { from, to, sentAt } of everyMessage(messages))
    if (
      from.kind === "agent" &&
      to.kind === "agent" &&
      from.terminalId !== to.terminalId &&
      mates.has(from.terminalId) &&
      mates.has(to.terminalId) &&
      (first === null || sentAt < first.at)
    )
      first = { id: from.terminalId, at: sentAt }
  return first?.id ?? null
}

// A path with forward slashes, as Windows' are written with the other.
const slashed = (path: string): string => path.replaceAll("\\", "/")

// Whether a work's path is in `folder`, a folder of the project ending in a slash: the path may be
// the worktree's own (relative) or absolute, and use either separator.
const isIn = (path: string, folder: string): boolean => {
  const own = slashed(path)
  return own.startsWith(folder) || own.includes(`/${folder}`)
}

// Whether the terminal's work changes a file in `folder`: a file removed doesn't.
const changesIn = (
  works: readonly Work[] | undefined,
  terminalId: string,
  folder: string,
): boolean =>
  (works ?? []).some(
    (work) =>
      work.terminalId === terminalId &&
      work.files.some(({ path, status }) => status !== "deleted" && isIn(path, folder)),
  )

// The item of `kind` on the terminal's bar, the newest shown first; null where none.
const shownOn = (items: readonly Item[], terminalId: string | undefined, kind: ItemKind) =>
  terminalId === undefined
    ? null
    : (items
        .filter((item) => item.kind === kind && isOnBar(item, terminalId))
        .toSorted((a, b) => b.shownAt - a.shownAt)[0]?.id ?? null)

// Questions in the Inbox from the terminals of `from`: their asks, or a harness's own question
// tool's (a request the Inbox lists as a question), whichever the agent used.
const questionsOf = (inbox: InboxState | undefined, from: ReadonlySet<string>) =>
  (inbox?.items ?? []).filter(
    (entry) => inboxType(entry) === "ask" && from.has(entry.source.terminalId),
  )

// How a question ends by the person's own doing: answered, in the Inbox or the terminal, or
// dismissed. Not one its agent's session took away (`ended`, `away`).
const byThePerson: ReadonlySet<SettledHow> = new Set([
  "answered",
  "terminal",
  "dismissed",
  "replied",
  "gone",
])

// Whether the person dealt with a question from `from`: an Inbox answer delivered to it, which
// stays in its messages; or its entry, settled by them, which the Inbox keeps as history.
const answeredOf = (
  messages: MessagesState | undefined,
  inbox: InboxState | undefined,
  from: ReadonlySet<string>,
): boolean =>
  everyMessage(messages).some(
    ({ inbox: kind, to }) => kind === "answer" && to.kind === "agent" && from.has(to.terminalId),
  ) || questionsOf(inbox, from).some((entry) => entry.settled && byThePerson.has(entry.settled.how))

// The Inbox entry of a question from `from` that waits there, not one already settled.
const askingRowOf = (inbox: InboxState | undefined, from: ReadonlySet<string>): string | null =>
  questionsOf(inbox, from).find((entry) => !entry.settled)?.id ?? null

// The first of the story's agents waiting on the person's yes: an unsettled Unblock entry.
const permissionOf = (
  inbox: InboxState | undefined,
  story: ReadonlySet<string>,
): TourSignals["permission"] => {
  const entry = (inbox?.items ?? []).find(
    (each) => !each.settled && inboxType(each) === "unblock" && story.has(each.source.terminalId),
  )
  return entry ? { terminalId: entry.source.terminalId } : null
}

// The tab at the top of a terminal's open pane, by what it is.
const openTab = (
  project: Workspace["projects"][number],
  terminalId: string | undefined,
  shown: TourSignals["shown"],
): PaneTab | null => {
  if (terminalId === undefined) return null
  for (const { state } of project.history) {
    const bar = state.bars[terminalId]
    if (!bar?.open) continue
    const key = topOf(bar)
    if (key === messagesKey) return "messages"
    for (const tab of ["page", "model"] as const) if (key !== null && key === shown[tab]) return tab
  }
  return null
}

// The first teammate the tour waits on at a screen of its own.
const heldOf = (agents: readonly TerminalMetadata[]): TourSignals["teamScreen"] => {
  for (const each of agents) {
    const state = leadState(each)
    if (state.kind === "screen")
      return { terminalId: each.id, screen: state.screen, program: each.process ?? null }
  }
  return null
}

// The first teammate whose agent left, its shell back.
const leftOf = (agents: readonly TerminalMetadata[]): TourSignals["teamLeft"] => {
  const each = agents.find((one) => leadState(one).kind === "left")
  return each ? { terminalId: each.id } : null
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
      const everyTerminal = project.history.flatMap(({ state }) => state.roster.terminals)
      const teammates = everyTerminal.filter(({ ledBy }) => ledBy === terminalId)
      const mates = new Set(teammates.map(({ id }) => id))
      const items = project.history.flatMap(({ state }) => state.items)
      // The maker is the teammate that showed a model or whose work changes the models.
      const maker = teammates.find(
        ({ id }) =>
          shownOn(items, id, "model") !== null || changesIn(sources.works, id, modelsFolder),
      )?.id
      const talker = talkerOf(sources.messages, mates) ?? undefined
      const lead = terminalId
      const leads = new Set([lead])
      // The teammate the story waits on and rings: one that hasn't said it is polished, quiet
      // before at work (a quiet one is the one to nudge), else any (every one that is polished
      // has ended its turn, with nothing left to do).
      const quiet = teammates.filter((each) => {
        const state = leadState(each)
        return state.kind === "agent" && !state.working
      })
      const unpolished = teammates.filter(
        ({ id }) => !wrote(sources.messages, id, lead, polishedNote),
      )
      const mate = (
        unpolished.find((each) => quiet.includes(each)) ??
        unpolished[0] ??
        quiet[0] ??
        teammates[0]
      )?.id
      const shown = {
        page: shownOn(items, lead, "page"),
        model: shownOn(items, maker, "model"),
      }
      const roles = {
        lead,
        ...(mate && { mate }),
        ...(talker && { talker }),
        ...(maker && { maker }),
      }
      const stateOf = (id: string | undefined): LeadState | undefined =>
        id === undefined ? undefined : leadState(teammates.find((each) => each.id === id))
      const told = (note: RegExp): number =>
        sources.messages
          ? teammates.filter(({ id }) => wrote(sources.messages, id, lead, note)).length
          : teammates.length
      const sheetRow = askingRowOf(sources.inbox, leads)
      return {
        lead: leadState(terminal),
        onScreen:
          workspace.activeProjectId === project.id && project.activeSessionId === session.id,
        roles,
        team: {
          count: teammates.length,
          named: teammates.filter(({ titleSource }) => titleSource?.kind === "agent").length,
          ids: teammates.map(({ id }) => id),
          firstIn: told(firstVersionNote),
          polished: told(polishedNote),
          working: teammates.some((each) => {
            const state = leadState(each)
            return state.kind === "agent" && state.working
          }),
          asked: questionsOf(sources.inbox, mates).length > 0,
        },
        approving: (sources.approvals ?? []).some(
          ({ from, action }) => action.type === "run" && from === lead,
        ),
        served:
          shownOn(items, lead, "page") !== null ||
          everyTerminal.some(({ openedBy, ledBy }) => openedBy === lead && !ledBy),
        sheet: {
          asking: sheetRow !== null,
          row: sheetRow,
          answered: answeredOf(sources.messages, sources.inbox, leads),
        },
        askingRow: askingRowOf(sources.inbox, mates),
        teamScreen: heldOf(teammates),
        teamLeft: leftOf(teammates),
        permission: permissionOf(sources.inbox, new Set([lead, ...mates])),
        shown,
        open: Object.fromEntries(
          Object.entries(roles).map(([role, id]) => [role, openTab(project, id, shown)]),
        ),
        mates: Object.fromEntries(
          [
            ["mate", mate],
            ["talker", talker],
            ["maker", maker],
          ].flatMap(([role, id]) => (id === undefined ? [] : [[role, stateOf(id)]])),
        ),
      }
    }
  return { lead: { kind: "gone" }, onScreen: false, ...noTeam }
}

// Whether two readings say the same: they are small, plain data.
export const sameSignals = (a: TourSignals, b: TourSignals): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
