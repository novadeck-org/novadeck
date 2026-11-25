import type { FilesState, ProjectFiles } from "@novadeck/core/files"
import type { AgentName } from "@novadeck/core/harnesses"
import type { InboxAnswer } from "@novadeck/core/inbox"
import {
  emptyCompanions,
  itemIdOf,
  type ChangeFileDiff,
  type Companions,
  type Item,
  type ItemContent,
} from "@novadeck/core/items"
import type { AgentConnection, Approval, Backend, Tour, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceAction } from "@novadeck/core/state"
import { createStore, type MutableStore, type Store } from "@novadeck/core/store"
import type { CompanionWindowMeta, Workspace } from "@novadeck/core/types"
import type { WorkPreview } from "@novadeck/core/works"

import type { DemoTurns } from "./agents/turns"
import { listEntries } from "./files"
import { isDemoInbox, type DemoInbox } from "./inbox"
import { createDemoMessages, isDemoMessages, type DemoMessages } from "./messages"
import type { Hero } from "./tour/content"
import type { Held } from "./tour/stage"
import { isDemoWorks, type DemoWorks } from "./works"
import { terminalOf } from "./workspace"

// Where the demo's tour runs, as the runner's runs in `~/.novadeck/tour`.
export const demoTourFolder = "~/.novadeck/tour"

// What a start answers, loaded only as one is readied: the website's visitor demo, which never
// offers the tour, doesn't carry it in its first load.
const loadRuns = () => import("./tour-runs")

// The screens a tour agent can be held at before Novadeck reaches it (`AgentStatus.startup`).
export type TourScreen = "startup" | "sign-in" | "hooks"

export const tourScreens: readonly TourScreen[] = ["startup", "sign-in", "hooks"]

// How the next run's agent goes, as the debug panel or a spec's address asks.
export type TourAgentPlan = {
  // The screen it waits at until it's answered.
  readonly screen?: TourScreen | undefined
  // It binds but never describes itself until nudged.
  readonly quiet: boolean
  // Its lead, once it described itself, opens no teammates until nudged again.
  readonly quietTeam?: boolean | undefined
  // Its lead asks the person's permission, as its harness's own dialog, before it goes on:
  // it waits until the person answers.
  readonly permission?: boolean | undefined
  // The modeller, once its lead opened it, does nothing until nudged.
  readonly quietModeller?: boolean | undefined
  // The modeller asks the person a question of its own after showing its model, and waits for
  // the answer before it reports.
  readonly mateAsks?: boolean | undefined
  // The lead's program ends once it has bound, its shell back at the prompt (as Claude Code
  // does where the person doesn't trust the folder).
  readonly shell?: boolean | undefined
  // This computer has neither Node nor Python: the lead runs no server and shows no page.
  readonly noPage?: boolean | undefined
}

// Asks the person's leave for `from` to run a command in a new terminal, as the app's approval
// dialog does; answers whether they allowed it.
export type TourApprover = (from: TerminalKey, command: string, cwd: string) => Promise<boolean>

// What an agent shows on its bar in the story: the item and what the pane reads of it, and, for
// a model, the bytes `part` reads, and, for changes, the diffs of its files.
export type TourShow = {
  readonly kind: "page" | "model" | "changes" | "image"
  readonly name: string
  readonly detail: string
  readonly path: string | null
  readonly url: string | null
  readonly content: ItemContent
  readonly bytes?: Uint8Array<ArrayBuffer> | undefined
  readonly diffs?: Readonly<Record<string, ChangeFileDiff>> | undefined
}

// The person's answer to the lead's sheet: for each question the option's index, or their own
// words. A question left out takes the first option.
export type TourSheetAnswer = {
  readonly world: number | string
  readonly kind: number | string
}

// What the story needs of the backend (see `tour/story.ts`): the workspace as it is now, a new
// terminal of the demo's numbering, the agents' messages and the Inbox where the demo has them,
// the works the agents' worktrees make, the Files panel's feed, the approval dialog, and what an
// agent shows on its bar.
export type TourStage = {
  readonly workspace: () => Workspace | undefined
  readonly newTerminal: Backend["newTerminal"]
  readonly messages: DemoMessages | undefined
  readonly inbox: DemoInbox | undefined
  // What the person last answered an entry of the Inbox, as the story's ask needs to read it.
  readonly answeredWith: (id: string) => InboxAnswer | undefined
  // Answers an entry as the person would in the Inbox.
  readonly answerEntry: (id: string, answer: InboxAnswer) => void
  // The demo's works, where it has them: the agents' worktrees and their changes.
  readonly works: DemoWorks | undefined
  // What the agents write in the tour's project, as the Files panel shows it, by the writer's
  // handle.
  readonly files:
    | {
        readonly write: (handle: string, path: string, kind: "added" | "modified") => void
        readonly end: (handle: string) => void
      }
    | undefined
  // The person's leave to run the lead's command.
  readonly approve: TourApprover
  // Shows an item on a terminal's bar, answering its id.
  readonly show: (key: TerminalKey, shown: TourShow) => string
  // Shows the lead's page, or, shown, loads it afresh as it now is.
  readonly page: (key: TerminalKey, content: ItemContent) => void
  // What an item shows now, once its file changed.
  readonly update: (
    id: string,
    now: { readonly content: ItemContent; readonly bytes?: Uint8Array<ArrayBuffer> | undefined },
  ) => void
  // The game the person named on the sheet, which the merged preview of the game's files shows.
  readonly chose: (hero: Hero) => void
}

export type DemoTour = Tour & {
  // Makes the next start fail, as the debug panel or a spec's `&tourStart=fails` asks: as a
  // folder of the person's own does, or (`tickets`) as the tour's service with no free run left does.
  readonly failNext: (how?: "folder" | "tickets") => void
  // The terminals whose agent was rung the start line, oldest first.
  readonly briefed: Store<readonly string[]>
  // The terminals whose agent was nudged, oldest first.
  readonly nudged: Store<readonly string[]>
  // The next run's agent waits at `screen` (none: runs as usual) until it's answered.
  readonly holdAt: (screen: TourScreen | undefined) => void
  // The next run's agent stays quiet until nudged.
  readonly goQuiet: (quiet?: boolean) => void
  // Answers the screen an agent waits at.
  readonly answer: () => void
  // Follows another set of connected agents and workspace: the debug demo's, which runs the
  // tour on the panel's agents and reuses the inner demo's tour (and so its player).
  readonly follow: (
    agents: Store<readonly AgentConnection[]>,
    workspace: () => Workspace | undefined,
  ) => void
  // What a spec asks of the address: `patienceMs` is what the UI waits before nudging, and
  // `screenMs` answers a held screen on its own after that long.
  readonly configure: (options: { patienceMs?: number; screenMs?: number; story?: boolean }) => void
  // Whether the lead plays the rest of the story after describing itself (`&tourStory=off`
  // stops it there).
  readonly story: () => boolean
  // The next run's lead asks the person's permission before it goes on.
  readonly askPermission: (ask?: boolean) => void
  // The next run's lead opens its team only once nudged again after it described itself.
  readonly goQuietTeam: (quiet?: boolean) => void
  // The next run's modeller does nothing until nudged.
  readonly goQuietModeller: (quiet?: boolean) => void
  // The next run's modeller asks the person a question of its own, and waits for it.
  readonly goMateAsks: (asks?: boolean) => void
  // The next run's lead's program ends once it has bound, its shell back.
  readonly goShell: (shell?: boolean) => void
  // The running lead's program ends, its shell back at the prompt: "It didn't start.".
  readonly exitToShell: () => void
  readonly shelled: (listener: () => void) => () => void
  // The next run has no page, as on a computer with neither Node nor Python.
  readonly goNoPage: (none?: boolean) => void
  // Answers the lead's sheet as the person would: the first options where none is given.
  // Nothing while none waits.
  readonly answerSheet: (answer?: Partial<TourSheetAnswer>) => void
  readonly sheet: (listener: (answer: TourSheetAnswer) => void) => () => void
  // Answers the modeller's own question as the person would, by its option or in their own
  // words: nothing while none waits.
  readonly answerMate: (answer?: number | string) => void
  readonly mate: (listener: (answer: number | string) => void) => () => void
  // The next keep fails, as when the folder can't be written, for the closing card to say so.
  readonly failKeep: (fail?: boolean) => void
  // Where the lead's command is asked of the person: the demo's own approval dialog by default,
  // or the debug panel's.
  readonly approver: (next: TourApprover) => void
  readonly approve: TourApprover
  // The lead's agent stops, its process exited, as one that can't go on does.
  readonly stop: () => void
  readonly stopped: (listener: () => void) => () => void
  // For the agent's player: what the next run is to do (taken once), when a held screen
  // answers itself, and a way to hear an answer.
  readonly take: () => TourAgentPlan
  readonly screenMs: () => number | undefined
  readonly answered: (listener: () => void) => () => void
}

// Where no dialog is wired, the lead's command isn't allowed.
const declined: TourApprover = () => Promise.resolve(false)

const tours = new WeakSet<Tour>()

// Whether a backend's tour is the demo's, which the debug panel and specs can drive.
export const isDemoTour = (tour: Tour | undefined): tour is DemoTour =>
  tour !== undefined && tours.has(tour)

// The demo's tour: readies a run as the runner does, with nothing to empty, answering the
// projects open at its folder as removed (the UI removes them from the workspace).
export const demoTour = (
  initialAgents: Store<readonly AgentConnection[]>,
  initialWorkspace: () => Workspace | undefined,
): DemoTour => {
  let agents = initialAgents
  let workspace = initialWorkspace
  let failing: "folder" | "tickets" | undefined
  let keepFails = false
  const briefed = createStore<readonly string[]>([])
  const nudged = createStore<readonly string[]>([])
  let plan: TourAgentPlan = { quiet: false }
  let screenMs: number | undefined
  let story = true
  let approver: TourApprover = declined
  // The story's events, which its lead hears: the stop, or an answer to a held screen; and the
  // person's answers to the lead's sheet and the modeller's question.
  const events = new Set<(event: "stop" | "answer" | "shell") => void>()
  const sheets = new Set<(answer: TourSheetAnswer) => void>()
  const mates = new Set<(answer: number | string) => void>()
  const hear = (listener: (event: "stop" | "answer" | "shell") => void) => {
    events.add(listener)
    return () => void events.delete(listener)
  }
  const tour: DemoTour = {
    failNext: (how = "folder") => {
      failing = how
    },
    briefed,
    nudged,
    holdAt: (screen) => {
      plan = { ...plan, screen }
    },
    goQuiet: (quiet = true) => {
      plan = { ...plan, quiet }
    },
    answer: () => {
      events.forEach((each) => each("answer"))
    },
    follow: (nextAgents, nextWorkspace) => {
      agents = nextAgents
      workspace = nextWorkspace
    },
    story: () => story,
    askPermission: (ask = true) => {
      plan = { ...plan, permission: ask }
    },
    goQuietTeam: (quiet = true) => {
      plan = { ...plan, quietTeam: quiet }
    },
    goQuietModeller: (quiet = true) => {
      plan = { ...plan, quietModeller: quiet }
    },
    goMateAsks: (asks = true) => {
      plan = { ...plan, mateAsks: asks }
    },
    goNoPage: (none = true) => {
      plan = { ...plan, noPage: none }
    },
    goShell: (shell = true) => {
      plan = { ...plan, shell }
    },
    exitToShell: () => events.forEach((each) => each("shell")),
    shelled: (listener) => hear((event) => event === "shell" && listener()),
    answerSheet: (answer = {}) =>
      sheets.forEach((each) => each({ world: answer.world ?? 0, kind: answer.kind ?? 0 })),
    sheet: (listener) => {
      sheets.add(listener)
      return () => void sheets.delete(listener)
    },
    answerMate: (answer = 0) => mates.forEach((each) => each(answer)),
    mate: (listener) => {
      mates.add(listener)
      return () => void mates.delete(listener)
    },
    failKeep: (fail = true) => {
      keepFails = fail
    },
    approver: (next) => {
      approver = next
    },
    approve: (from, command, cwd) => approver(from, command, cwd),
    stop: () => events.forEach((each) => each("stop")),
    stopped: (listener) => hear((event) => event === "stop" && listener()),
    configure: (options) => {
      story = options.story ?? true
      const own: { patienceMs?: number } = tour
      if (options.patienceMs === undefined) delete own.patienceMs
      else own.patienceMs = options.patienceMs
      screenMs = options.screenMs
    },
    take: () => {
      const taken = plan
      plan = { quiet: false }
      return taken
    },
    screenMs: () => screenMs,
    answered: (listener) => {
      return hear((event) => event === "answer" && listener())
    },
    prepare: async () => {
      const fails = failing
      failing = undefined
      const { demoRun, demoRefusal } = await loadRuns()
      if (fails) throw demoRefusal(fails)
      const connected = agents
        .getSnapshot()
        .some((each) => each.agent === "opencode" && each.connected)
      if (!connected)
        throw new Error("Novadeck isn't connected to OpenCode, so the tour can't start.")
      const removed = (workspace()?.projects ?? [])
        .filter((project) => project.directory === demoTourFolder)
        .map((project) => project.id)
      return {
        ...demoRun("opencode"),
        directory: demoTourFolder,
        removed,
        page: plan.noPage !== true,
      }
    },
    brief: (terminalId) => {
      briefed.update((ids) => [...ids, terminalId])
      return Promise.resolve()
    },
    nudge: (terminalId) => {
      nudged.update((ids) => [...ids, terminalId])
      return Promise.resolve()
    },
    keep: () => {
      if (!keepFails) return Promise.resolve()
      keepFails = false
      return Promise.reject(new Error("AGENTS.md can't be written in this folder."))
    },
  }
  tours.add(tour)
  return tour
}

// The harness a tour terminal's command starts, which names its agent.
export const tourHarness = (command: string): AgentName | undefined => {
  const program = command.trim().split(/\s+/)[0]
  return program === "claude" || program === "codex" || program === "agy" || program === "opencode"
    ? program
    : undefined
}

// The demo's approval dialog for the tour where the backend has none of its own: the lead's
// command waits in a store the app's approvals read, and the person's answer resolves it.
const tourApprovals = (): {
  readonly approvals: NonNullable<Backend["approvals"]>
  readonly ask: TourApprover
} => {
  const pending = createStore<readonly Approval[]>([])
  const answers = new Map<string, (approved: boolean) => void>()
  let count = 0
  return {
    approvals: {
      pending,
      answer: (requestId, approved) => {
        const settle = answers.get(requestId)
        answers.delete(requestId)
        pending.update((waiting) => waiting.filter((each) => each.requestId !== requestId))
        settle?.(approved)
      },
    },
    ask: (from, command, cwd) =>
      new Promise((resolve) => {
        count += 1
        const requestId = `tour-approval-${count}`
        answers.set(requestId, resolve)
        pending.update((waiting) => [
          ...waiting,
          {
            requestId,
            from: from.terminalId,
            terminalId: from.terminalId,
            action: { type: "run", command, cwd },
          },
        ])
      }),
  }
}

// How much of a model's file one read of it gives.
const partBytes = 2 * 1024 * 1024

// The backend with the tour's agent played in the terminals the UI adds in the tour's folder,
// as a runner would report one (see `tour/player.ts`, loaded as the first one starts). Where the
// story is on, the lead's teammates talk through the backend's messages (made here where it has
// none: only terminals that join show one), ask through its Inbox, show their items through its
// companions and write through its Files, and the lead's command waits in an approval.
export const withTourAgent = (
  backend: Backend,
  turns: DemoTurns,
  // Whether the tour's project lists files where the demo has no Files panel of its own: only
  // where the tour is offered, so no other demo shows a Files button the tour alone needs.
  offerFiles = false,
): Backend => {
  let latest: Workspace | undefined
  // The demo's tour, on its own agents, joins here, not in every demo: the website's visitor
  // demo, which offers no tour, carries none of it.
  const tour = isDemoTour(backend.tour)
    ? backend.tour
    : demoTour(backend.agents?.state ?? createStore<readonly AgentConnection[]>([]), () => latest)
  const own = backend.approvals ? undefined : tourApprovals()
  if (own) tour.approver(own.ask)
  let sink: Parameters<NonNullable<Backend["start"]>>[0] | undefined
  const stops = new Set<() => void>()
  const exists = (target: { projectId: string; workspaceSessionId: string }, terminalId: string) =>
    terminalOf(latest, { ...target, terminalId }) !== undefined
  const messages = backend.messages ?? createDemoMessages([], false, exists)
  const inbox = isDemoInbox(backend.inbox) ? backend.inbox : undefined
  const answers = new Map<string, InboxAnswer>()
  const answerEntry = (id: string, answer: InboxAnswer): void => {
    answers.set(id, answer)
    inbox?.answer(id, answer)
  }
  const works = isDemoWorks(backend.works) ? backend.works : undefined
  // The lead of the latest run.
  let lead: TerminalKey | undefined
  let hero: Hero | undefined
  // Whether a project is the tour's, by its folder.
  const isTour = (projectId: string): boolean =>
    latest?.projects.find(({ id }) => id === projectId)?.directory === demoTourFolder
  // The tour's repo in the Files panel, beside whatever files the demo has: the tour's project
  // lists its own files, the changes laid over them by the agents' writes.
  const baseFiles: ProjectFiles = backend.files ?? {
    state: createStore({ projects: {} }),
    list: (_projectId, folder) => Promise.resolve(listEntries(["README.md"], folder)),
  }
  // Where the agents' writes go: the panel's own feed, where the demo keeps one it can change.
  const feed: MutableStore<FilesState> | undefined =
    "update" in baseFiles.state ? (baseFiles.state as MutableStore<FilesState>) : undefined
  const files: ProjectFiles = {
    ...baseFiles,
    list: async (projectId, folder) => {
      if (!isTour(projectId)) return baseFiles.list(projectId, folder)
      const { tourEntries, tourIgnored } = await import("./tour/content")
      return listEntries(tourEntries, folder, tourIgnored)
    },
  }

  // What the agents showed, and whoever follows it.
  const held = new Map<string, Held>()
  const following = new Map<string, Set<(content: ItemContent) => void>>()
  const tell = (id: string): void => {
    const found = held.get(id)
    if (found) for (const on of following.get(id) ?? []) on(found.content)
  }
  // The stage the story plays on, built as the first agent starts and kept for the run's agents.
  let staged: Promise<TourStage> | undefined
  const stageOf = (): Promise<TourStage> =>
    (staged ??= import("./tour/stage").then(({ createStage }) =>
      createStage({
        latest: () => latest,
        sink: () => sink,
        tour,
        newTerminal: (request) => backend.newTerminal(request),
        messages: isDemoMessages(messages) ? messages : undefined,
        inbox,
        answers,
        answerEntry,
        works,
        feed,
        lead: () => lead,
        setHero: (next) => {
          hero = next
        },
        held,
        tell,
      }),
    ))
  // The tour's items follow what the agents showed; the tour's repo opens in the project's window
  // as the runner would make it (where the demo's panes can't): pointed at the file, the window
  // made under the id asked.
  const base = backend.companions ?? emptyCompanions()
  const projectWindows = new Map<string, { itemId: string; windowId: string }>()
  let opened = 0
  const companions: Companions = {
    ...base,
    follow: (at, itemId, options, on) => {
      const id = String(itemId)
      if (!held.has(id)) return base.follow(at, itemId, options, on)
      const each = following.get(id) ?? new Set()
      each.add(on)
      following.set(id, each)
      on(held.get(id)!.content)
      return () => void each.delete(on)
    },
    part: (at, itemId, part) => {
      const found = held.get(String(itemId))
      if (!found?.bytes)
        return base.part
          ? base.part(at, itemId, part)
          : Promise.reject(new Error("There is nothing to read there"))
      if (part.file !== undefined)
        return Promise.reject(new Error("That file isn't one the model names"))
      if (found.content.state === "ready" && found.content.stamp !== part.stamp)
        return Promise.resolve({ state: "changed" })
      return Promise.resolve({
        state: "part",
        bytes: found.bytes.slice(part.offset, part.offset + partBytes),
      })
    },
    changeFile: (at, itemId, path, layers) => {
      const diff = held.get(String(itemId))?.diffs?.[path]
      if (diff) return Promise.resolve(diff)
      return (
        base.changeFile?.(at, itemId, path, layers) ?? Promise.reject(new Error("No such change"))
      )
    },
    changeRange: (at, itemId, layers) => {
      const found = held.get(String(itemId))?.content
      if (found?.state === "ready" && found.content.kind === "changes")
        return Promise.resolve({ files: found.content.files, truncated: false })
      return base.changeRange?.(at, itemId, layers) ?? Promise.reject(new Error("No such change"))
    },
    changeRead: (at, itemId, path) =>
      held.get(String(itemId))
        ? Promise.resolve()
        : (base.changeRead?.(at, itemId, path) ?? Promise.resolve()),
    ...(base.openInProject
      ? {}
      : {
          openInProject: async (at, path, windowId) => {
            const { mainOf } = await import("./tour/content")
            const folder = latest?.projects.find(({ id }) => id === at.projectId)?.directory
            const full = /^[/~]/.test(path) || !folder ? path : `${folder}/${path}`
            const key = `${at.projectId}/${at.workspaceSessionId}`
            const known = projectWindows.get(key)
            const id = known?.itemId ?? `tour-file-${(opened += 1)}`
            const window = known?.windowId ?? windowId
            projectWindows.set(key, { itemId: id, windowId: window })
            const name = path.split("/").pop() ?? path
            const lines = mainOf(path) ?? [`# ${path}`]
            const content: ItemContent = {
              state: "ready",
              stamp: "1",
              content: {
                kind: "file",
                path: full,
                firstLine: 1,
                lines,
                from: 1,
                to: lines.length,
                total: lines.length,
                truncated: false,
                clamped: false,
              },
            }
            held.set(id, { content })
            const item: Item = {
              id: itemIdOf(id),
              holder: { windowId: window },
              kind: "file",
              name,
              detail: path,
              path: full,
              url: null,
              lines: null,
              secret: false,
              by: "person",
              from: null,
              version: 1,
              openAsked: true,
              shownAt: Date.now(),
              plan: null,
            }
            const meta: CompanionWindowMeta = {
              id: window,
              home: "project",
              itemId: item.id,
              name,
              titleSource: { kind: "default" },
            }
            sink?.dispatch([
              { type: "item/upsert", target: at, item },
              { type: "window/upsert", target: at, window: meta },
            ])
            return { item, window: meta }
          },
        }),
  }
  // The files the agents' works change, as they merge: `src/main.js`.
  const previewed: NonNullable<Backend["works"]> | undefined = backend.works && {
    ...backend.works,
    preview: async (projectId, path): Promise<WorkPreview> => {
      if (!isTour(projectId)) return backend.works!.preview(projectId, path)
      const { mainOf, hunkOf } = await import("./tour/content")
      const main = mainOf(path)
      if (!main) return { main: null, works: [], renames: [] }
      const changing = (works?.worksOf(projectId) ?? []).flatMap((work) => {
        const file = work.files.find((each) => each.path === path)
        const hunk = file && hunkOf(path, hero)
        if (!file || !hunk) return []
        return [
          {
            root: work.root,
            terminalId: work.terminalId,
            branch: work.branch ?? null,
            status: "modified" as const,
            changedAt: file.changedAt,
            hunks: [hunk],
          },
        ]
      })
      return { main: main.join("\n") + "\n", works: changing, renames: [] }
    },
  }
  const play = (action: Extract<WorkspaceAction, { type: "terminal/add" }>): void => {
    const harness = tourHarness(action.terminal.command)
    const at = sink
    if (!harness || !at) return
    const key = { ...action.target, terminalId: action.terminal.id }
    lead = key
    hero = undefined
    held.clear()
    let stop: (() => void) | undefined
    let stopped = false
    const end = () => {
      stopped = true
      stop?.()
    }
    stops.add(end)
    const terminal = () => terminalOf(latest, key)
    void Promise.all([stageOf(), import("./tour/player")]).then(([stage, { playTourAgent }]) => {
      if (stopped) return
      stop = playTourAgent({
        key,
        harness,
        tour,
        turns,
        dispatch: at.dispatch,
        terminal,
        stage,
      })
    })
  }
  return {
    ...backend,
    tour,
    messages,
    ...(backend.files || offerFiles ? { files } : {}),
    companions,
    ...(own && { approvals: own.approvals }),
    ...(previewed && { works: previewed }),
    ...(inbox && backend.inbox ? { inbox: { ...backend.inbox, answer: answerEntry } } : {}),
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
      for (const action of actions) {
        // A teammate the lead opened is played by the lead's story, not as an agent of its own.
        if (
          action.type !== "terminal/add" ||
          action.terminal.directory !== demoTourFolder ||
          action.terminal.ledBy ||
          action.terminal.openedBy
        )
          continue
        play(action)
      }
    },
    start: (next) => {
      sink = next
      const stop = backend.start?.(next)
      return () => {
        stop?.()
        for (const end of stops) end()
        stops.clear()
        lead = undefined
        if (sink === next) sink = undefined
      }
    },
  }
}
