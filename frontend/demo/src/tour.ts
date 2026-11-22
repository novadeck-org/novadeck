import type { ProjectFiles } from "@novadeck/core/files"
import type { AgentName } from "@novadeck/core/harnesses"
import type { InboxAnswer } from "@novadeck/core/inbox"
import {
  emptyCompanions,
  itemIdOf,
  type Companions,
  type Item,
  type ItemContent,
} from "@novadeck/core/items"
import type { AgentConnection, Backend, Tour } from "@novadeck/core/port"
import { createStore, type Store } from "@novadeck/core/store"
import type { CompanionWindowMeta, Workspace } from "@novadeck/core/types"
import type { WorkPreview } from "@novadeck/core/works"

import type { DemoTurns } from "./agents/turns"
import { listEntries } from "./files"
import { isDemoInbox, type DemoInbox } from "./inbox"
import { createDemoMessages, isDemoMessages, type DemoMessages } from "./messages"
import { isDemoWorks, type DemoWorks } from "./works"
import { terminalOf } from "./workspace"

// Where the demo's tour runs, as the runner's runs in `~/.novadeck/tour`.
export const demoTourFolder = "~/.novadeck/tour"

// What a start answers, loaded only as one is readied: the website's visitor demo, which never
// offers the tour, doesn't carry it in its first load.
const runs = () => import("./tour-runs")

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
}

// What a lead needs of the backend to play the story's rest (see `tour/story.ts`): the
// workspace as it is now, a new terminal of the demo's numbering, the agents' messages and the
// Inbox where the demo has them, the works the fixers' worktrees make, and a way to say which
// way the person had whole amounts shown.
export type TourStage = {
  readonly workspace: () => Workspace | undefined
  readonly newTerminal: Backend["newTerminal"]
  readonly messages: DemoMessages | undefined
  readonly inbox: DemoInbox | undefined
  // What the person last answered a row of the Inbox, as the story's ask needs to read it.
  readonly answeredWith: (id: string) => InboxAnswer | undefined
  // Answers a row as the person would in the Inbox.
  readonly answerRow: (id: string, answer: InboxAnswer) => void
  // The demo's works, where it has them: the fixers' worktrees and their changes to split.js.
  readonly works: DemoWorks | undefined
  // The option the person picked for whole amounts, which the merged preview of split.js shows.
  readonly picked: (option: number) => void
}

export type DemoTour = Tour & {
  // Makes the next start fail, as the debug panel or a spec's `&tourStart=fails` asks: as a
  // folder of the person's own does, or (`unlisted`) as Codex not signed in yet does.
  readonly failNext: (how?: "folder" | "unlisted") => void
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
  // What a spec asks of the address: `patienceMs` is what the UI waits before nudging, and
  // `screenMs` answers a held screen on its own after that long.
  // Follows another set of connected agents and workspace: the debug demo's, which runs the
  // tour on the panel's agents and reuses the inner demo's tour (and so its player).
  readonly follow: (
    agents: Store<readonly AgentConnection[]>,
    workspace: () => Workspace | undefined,
  ) => void
  readonly configure: (options: { patienceMs?: number; screenMs?: number; story?: boolean }) => void
  // Whether the lead plays the rest of the story after describing itself (`&tourStory=off`
  // stops it there).
  readonly story: () => boolean
  // The next run's lead asks the person's permission before it goes on.
  readonly askPermission: (ask?: boolean) => void
  // The next run's lead opens its team only once nudged again after it described itself.
  readonly goQuietTeam: (quiet?: boolean) => void
  // Answers the second fixer's ask by its option, as the person would: nothing while none waits.
  readonly answerMoney: (option?: number) => void
  readonly money: (listener: (option: number) => void) => () => void
  // Hears the person's new terminal handed to the tour (`tour.fixer`).
  readonly onFixer: (listener: (terminalId: string) => void) => () => void
  // The lead's agent stops, its process exited, as one that can't go on does.
  readonly stop: () => void
  readonly stopped: (listener: () => void) => () => void
  // For the agent's player: what the next run is to do (taken once), when a held screen
  // answers itself, and a way to hear an answer.
  readonly take: () => TourAgentPlan
  readonly screenMs: () => number | undefined
  readonly answered: (listener: () => void) => () => void
}

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
  let failing: "folder" | "unlisted" | undefined
  const briefed = createStore<readonly string[]>([])
  const nudged = createStore<readonly string[]>([])
  let plan: TourAgentPlan = { quiet: false }
  let screenMs: number | undefined
  let story = true
  // The story's events, which its lead hears: an option the person picked, or the stop.
  const fixers = new Set<(terminalId: string) => void>()
  const events = new Set<(event: number | "stop" | "answer") => void>()
  const hear = (listener: (event: number | "stop" | "answer") => void) => {
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
    answerMoney: (option = 0) => events.forEach((each) => each(option)),
    money: (listener) => hear((event) => typeof event === "number" && listener(event)),
    onFixer: (listener) => {
      fixers.add(listener)
      return () => void fixers.delete(listener)
    },
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
    prepare: async (agent) => {
      const fails = failing
      failing = undefined
      const { demoRun, demoRefusal } = await runs()
      if (fails) throw demoRefusal(fails, agent)
      const connected = agents.getSnapshot().some((each) => each.agent === agent && each.connected)
      if (!connected) throw new Error("Novadeck isn't connected to it, so the tour can't start.")
      const removed = (workspace()?.projects ?? [])
        .filter((project) => project.directory === demoTourFolder)
        .map((project) => project.id)
      return { ...demoRun(agent), directory: demoTourFolder, removed }
    },
    brief: (terminalId) => {
      briefed.update((ids) => [...ids, terminalId])
      return Promise.resolve()
    },
    nudge: (terminalId) => {
      nudged.update((ids) => [...ids, terminalId])
      return Promise.resolve()
    },
    // The terminal is the run's second fixer: the story's lead takes it (and ignores one that
    // isn't a shell of the tour's, or a second).
    fixer: (terminalId) => {
      fixers.forEach((each) => each(terminalId))
      return Promise.resolve()
    },
  }
  tours.add(tour)
  return tour
}

// The harness a tour terminal's command starts, which names its agent.
export const tourHarness = (command: string): AgentName | undefined => {
  const program = command.trim().split(/\s+/)[0]
  return program === "claude" || program === "codex" || program === "agy" ? program : undefined
}

// The backend with the tour's agent played in the terminals the UI adds in the tour's folder,
// as a runner would report one (see `tour/player.ts`, loaded as the first one starts). Where the
// story is on, the lead's teammates talk through the backend's messages (made here where it has
// none: only terminals that join show one), ask through its Inbox and show their card through
// its companions.
export const withTourAgent = (backend: Backend, turns: DemoTurns): Backend => {
  let latest: Workspace | undefined
  // The demo's tour, on its own agents, joins here, not in every demo: the website's visitor
  // demo, which offers no tour, carries none of it.
  const tour = isDemoTour(backend.tour)
    ? backend.tour
    : demoTour(backend.agents?.state ?? createStore<readonly AgentConnection[]>([]), () => latest)
  let sink: Parameters<NonNullable<Backend["start"]>>[0] | undefined
  const stops = new Set<() => void>()
  const exists = (target: { projectId: string; workspaceSessionId: string }, terminalId: string) =>
    terminalOf(latest, { ...target, terminalId }) !== undefined
  const messages = backend.messages ?? createDemoMessages([], false, exists)
  const inbox = isDemoInbox(backend.inbox) ? backend.inbox : undefined
  const answers = new Map<string, InboxAnswer>()
  const answerRow = (id: string, answer: InboxAnswer): void => {
    answers.set(id, answer)
    inbox?.answer(id, answer)
  }
  const works = isDemoWorks(backend.works) ? backend.works : undefined
  let money = 0
  const stage: TourStage = {
    workspace: () => latest,
    newTerminal: (request) => backend.newTerminal(request),
    messages: isDemoMessages(messages) ? messages : undefined,
    inbox,
    answeredWith: (id) => answers.get(id),
    answerRow,
    works,
    picked: (option) => {
      money = option
    },
  }
  // Whether a project is the tour's, by its folder.
  const isTour = (projectId: string): boolean =>
    latest?.projects.find(({ id }) => id === projectId)?.directory === demoTourFolder
  // The tour's repo in the Files panel, beside whatever files the demo has: the tour's project
  // lists its own files, the changes laid over them by the works.
  const baseFiles: ProjectFiles = backend.files ?? {
    state: createStore({ projects: {} }),
    list: (_projectId, folder) => Promise.resolve(listEntries(["README.md"], folder)),
  }
  const files: ProjectFiles = {
    ...baseFiles,
    list: async (projectId, folder) => {
      if (!isTour(projectId)) return baseFiles.list(projectId, folder)
      const { tourEntries } = await import("./tour/split")
      return listEntries(tourEntries, folder)
    },
  }
  // Where the demo's panes can't open a file in the project's window (the plain demo's), the tour's
  // repo opens in one as the runner would make it: pointed at the file, the window made under
  // the id asked, which `follow` then reads from what the story kept.
  const base = backend.companions ?? emptyCompanions()
  const heldContent = new Map<string, ItemContent>()
  const projectWindows = new Map<string, { itemId: string; windowId: string }>()
  let opened = 0
  const companions: Companions = base.openInProject
    ? base
    : {
        ...base,
        follow: (target, itemId, options, on) => {
          const content = heldContent.get(String(itemId))
          if (!content) return base.follow(target, itemId, options, on)
          on(content)
          return () => {}
        },
        openInProject: async (target, path, windowId) => {
          const { splitFile, splitMain } = await import("./tour/split")
          const folder = latest?.projects.find(({ id }) => id === target.projectId)?.directory
          const full = /^[/~]/.test(path) || !folder ? path : `${folder}/${path}`
          const key = `${target.projectId}/${target.workspaceSessionId}`
          const known = projectWindows.get(key)
          const id = known?.itemId ?? `tour-file-${(opened += 1)}`
          const window = known?.windowId ?? windowId
          projectWindows.set(key, { itemId: id, windowId: window })
          const name = path.split("/").pop() ?? path
          const lines = path === splitFile ? splitMain.trimEnd().split("\n") : [`# ${path}`]
          heldContent.set(id, {
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
          })
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
            { type: "item/upsert", target, item },
            { type: "window/upsert", target, window: meta },
          ])
          return { item, window: meta }
        },
      }
  // split.js as both fixers' works merge it, where the demo has works.
  const previewed: NonNullable<Backend["works"]> | undefined = backend.works && {
    ...backend.works,
    preview: async (projectId, path): Promise<WorkPreview> => {
      if (!isTour(projectId)) return backend.works!.preview(projectId, path)
      const { splitFile, splitMain, tipBranch, tipHunk, moneyHunk } = await import("./tour/split")
      if (path !== splitFile) return { main: null, works: [], renames: [] }
      const changing = (works?.worksOf(projectId) ?? []).flatMap((work) => {
        const file = work.files.find((each) => each.path === splitFile)
        if (!file) return []
        return [
          {
            root: work.root,
            terminalId: work.terminalId,
            branch: work.branch ?? null,
            status: "modified" as const,
            changedAt: file.changedAt,
            hunks: [work.branch === tipBranch ? tipHunk : moneyHunk(money)],
          },
        ]
      })
      return { main: splitMain, works: changing, renames: [] }
    },
  }
  return {
    ...backend,
    tour,
    messages,
    files,
    companions,
    ...(previewed && { works: previewed }),
    ...(inbox && backend.inbox ? { inbox: { ...backend.inbox, answer: answerRow } } : {}),
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
      for (const action of actions) {
        // A teammate the lead opened is played by the lead's story, not as a lead of its own.
        if (
          action.type !== "terminal/add" ||
          action.terminal.directory !== demoTourFolder ||
          action.terminal.ledBy
        )
          continue
        const harness = tourHarness(action.terminal.command)
        const at = sink
        if (!harness || !at) continue
        const key = { ...action.target, terminalId: action.terminal.id }
        let stop: (() => void) | undefined
        let stopped = false
        const end = () => {
          stopped = true
          stop?.()
        }
        stops.add(end)
        void import("./tour/player").then(({ playTourAgent }) => {
          if (stopped) return
          stop = playTourAgent({
            key,
            harness,
            tour,
            turns,
            dispatch: at.dispatch,
            terminal: () => terminalOf(latest, key),
            stage,
          })
        })
      }
    },
    start: (next) => {
      sink = next
      const stop = backend.start?.(next)
      return () => {
        stop?.()
        for (const end of stops) end()
        stops.clear()
        if (sink === next) sink = undefined
      }
    },
  }
}
