// The Files panel bench's page: the real panel (FilesPanel) wired as SidebarSection wires it, on
// a synthetic project, with its works coming through the runner adapter's real works feed
// (createRunnerWorks) from a fake `works.watch` stream. The bench drives it through `window.bench`.
import "../../../../frontend/ui/src/styles.css"
import { Profiler, useMemo, useSyncExternalStore, type ProfilerOnRenderCallback } from "react"
import { createRoot } from "react-dom/client"

import type { FolderListing } from "../../../../frontend/core/src/files.ts"
import { createStore } from "../../../../frontend/core/src/store.ts"
import type { WorksState } from "../../../../frontend/core/src/works.ts"
import { createRunnerWorks } from "../../../../frontend/runner-adapter/src/works.ts"
import { useStoreSelector } from "../../../../frontend/ui/src/app/controller/useStoreSelector.ts"
import { sameWorks } from "../../../../frontend/ui/src/app/files-feed.ts"
import { filesOfWorks, type Owner } from "../../../../frontend/ui/src/sidebar/files-works.ts"
import { FilesPanel } from "../../../../frontend/ui/src/sidebar/FilesPanel.tsx"
import { pulseMs } from "../../../../frontend/ui/src/sidebar/usePulses.ts"
import {
  changedIn,
  changedPaths,
  restamp,
  handleOf,
  makeProject,
  rootOf,
  seedPaths,
  terminalOf,
  workOf,
  type Config,
} from "../scenario.ts"
import type { Bench, Tail, Timed } from "../summary.ts"

const config = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Config
const projectId = "bench"
const project = makeProject(config)
const edits = changedPaths(project, config)

// The runner's `works.watch` items, handed over as the bench pushes them.
type Item = { type: string; [key: string]: unknown }
const queue: Item[] = []
let waiting: ((item: IteratorResult<Item, undefined>) => void) | undefined
const push = (item: Item): void => {
  active()
  queue.push(item)
  const wake = waiting
  waiting = undefined
  const next = queue.shift()
  if (wake && next) wake({ done: false, value: next })
}
// Hands the items over one to a task, as the app's WebSocket delivers its messages.
const channel = new MessageChannel()
channel.port1.start()
const task = (): Promise<void> =>
  new Promise((resolve) => {
    channel.port1.addEventListener("message", () => resolve(), { once: true })
    channel.port2.postMessage(null)
  })
const feed = async (items: readonly Item[]): Promise<void> => {
  for (const [place, item] of items.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- One item to a task.
    if (place > 0) await task()
    push(item)
  }
}
const stream = {
  next: (): Promise<IteratorResult<Item, undefined>> => {
    const next = queue.shift()
    if (next) return Promise.resolve({ done: false, value: next })
    return new Promise((resolve) => {
      waiting = resolve
    })
  },
  return: (): Promise<IteratorResult<Item, undefined>> =>
    Promise.resolve({ done: true, value: undefined }),
  [Symbol.asyncIterator]() {
    return this
  },
}
// Nothing left to hand the adapter, and it has asked for more.
const drained = (): boolean => queue.length === 0 && waiting !== undefined
const never = {
  next: () => new Promise<never>(() => {}),
  return: () => Promise.resolve({ done: true, value: undefined }),
  [Symbol.asyncIterator]() {
    return this
  },
}
// Only the stream's two calls are made; the rest of the runner's are the person's.
type Calls = Parameters<typeof createRunnerWorks>[0]
const { works } = createRunnerWorks({
  watch: () => stream,
  made: () => never,
} as unknown as Pick<Calls, "watch" | "made"> as Calls)

const owners: ReadonlyMap<string, Owner> = new Map(
  Array.from({ length: config.worktrees }, (_, index) => [
    terminalOf(index),
    {
      handle: handleOf(index),
      wrote: `${rootOf(index)}/${edits[index]?.[0] ?? ""}`,
    },
  ]),
)
const roster = Array.from({ length: config.worktrees }, (_, index) => handleOf(index))

// The panel's reader, counting its calls.
let reads = 0
// Reads asked for and not yet answered.
let outstanding = 0
const list = (folder: string): Promise<FolderListing> => {
  reads += 1
  outstanding += 1
  active()
  const listing = project.listings.get(folder)
  return (
    listing ? Promise.resolve(listing) : Promise.reject(new Error(`no folder ${folder}`))
  ).finally(() => {
    outstanding -= 1
    active()
  })
}

const turnStore = createStore(0)
const squads: readonly (readonly string[])[] = []
const noop = (): void => {}
const openFile = (): Promise<void> => Promise.resolve()

// When anything last happened that the panel may answer: an event, a read, a commit, a long task.
let lastActivity = performance.now()
const active = (): void => {
  lastActivity = performance.now()
}
let commits = 0
let totalCommits = 0
let reactMs = 0
const onRender: ProfilerOnRenderCallback = (_id, _phase, actual) => {
  commits += 1
  totalCommits += 1
  reactMs += actual
  active()
}

// Wired as SidebarSection does: the works' overlay of the project, the followed works.
const Harness = (): React.JSX.Element => {
  const allWorks = useStoreSelector(works.state, (state: WorksState) => state.works, sameWorks)
  const overlay = useMemo(() => filesOfWorks(allWorks, projectId, owners), [allWorks])
  const turn = useSyncExternalStore(turnStore.subscribe, turnStore.getSnapshot)
  return (
    <div style={{ position: "relative", width: 320, height: 900 }}>
      <FilesPanel
        project={overlay}
        list={list}
        turn={turn}
        watch={works.watch}
        onOpenFile={openFile}
        selectedHandle={undefined}
        roster={roster}
        squads={squads}
        active
        visible
        onHide={noop}
      />
    </div>
  )
}

const longTasks: number[] = []
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    longTasks.push(entry.duration)
    lastActivity = Math.max(lastActivity, entry.startTime + entry.duration)
  }
})
observer.observe({ type: "longtask", buffered: false })

// The first frame after the latest commit: when what it drew is on screen.
const committed = (): boolean => totalCommits > 0
let seenCommits = 0
let paintedAt = performance.now()
const tick = (): void => {
  if (totalCommits !== seenCommits) {
    seenCommits = totalCommits
    paintedAt = performance.now()
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// Quiet for `quietMs`: every event handed over and taken, no folder read out, and no commit or
// long task for that long. A work published after a delay (the adapter may hold a batch for a
// timer) lands inside the wait, so a build that defers is measured through its commit.
const quietMs = 200
const busy = (): boolean =>
  !drained() || outstanding > 0 || performance.now() - lastActivity < quietMs
const settle = async (): Promise<void> => {
  const deadline = performance.now() + 60_000
  while (busy()) {
    if (performance.now() > deadline) throw new Error("the panel didn't settle in 60 s")
    // oxlint-disable-next-line no-await-in-loop -- Polls the clock.
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const rows = (): number => document.querySelectorAll('[role="tree"] [data-path]').length

const measured = async (start: () => Promise<void>): Promise<Timed> => {
  commits = 0
  reactMs = 0
  reads = 0
  observer.takeRecords()
  longTasks.length = 0
  const from = performance.now()
  seenCommits = totalCommits
  paintedAt = from
  active()
  await start()
  await settle()
  const wallMs = paintedAt - from
  for (const entry of observer.takeRecords()) longTasks.push(entry.duration)
  return { wallMs, longTasks: [...longTasks], commits, reactMs, reads, rows: rows() }
}

// The trails' timers clear their highlights some time after a change, each a commit; waited out
// here so they are not left to land in the next poll, and counted on their own.
const after = async (): Promise<Tail> => {
  commits = 0
  reactMs = 0
  await new Promise((resolve) => setTimeout(resolve, pulseMs + 300))
  await settle()
  return { commits, reactMs }
}

// Each worktree's file stamps, which a poll moves on only for the files it writes.
const stamps = new Map<number, readonly number[]>()
const changes = new Map<number, number>()

const ready = (async () => {
  works.watch()
  // The seed work leaves a change in every folder, so the panel opens them all on first sight
  // of the root; it is let go below, and the folders stay open.
  const now = Date.now()
  const seed = seedPaths(project)
  await feed([
    { type: "reset" },
    {
      type: "changed",
      work: workOf(
        -1,
        seed,
        seed.map(() => now),
        projectId,
      ),
    },
    ...edits.map((paths, index) => {
      const each = paths.map(() => now)
      stamps.set(index, each)
      return { type: "changed", work: workOf(index, paths, each, projectId) }
    }),
    { type: "synced" },
  ])
  await settle()
  const root = document.getElementById("root")!
  createRoot(root).render(
    <Profiler id="bench" onRender={onRender}>
      <Harness />
    </Profiler>,
  )
  // The render is scheduled, not done: wait for its first commit, then for what that sets going.
  while (!committed()) {
    // oxlint-disable-next-line no-await-in-loop -- Polls for the commit.
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await settle()
  await feed([{ type: "removed", root: "/work/seed", projectId }])
  await settle()
})()

const bench: Bench = {
  ready,
  poll: (poll) =>
    measured(() =>
      feed([
        ...changedIn(poll, config).map((index) => {
          const count = changes.get(index) ?? 0
          changes.set(index, count + 1)
          const each = restamp(stamps.get(index)!, count, config.written, Date.now())
          stamps.set(index, each)
          return { type: "changed", work: workOf(index, edits[index]!, each, projectId) }
        }),
        ...(config.synced ? [{ type: "synced" }] : []),
      ]),
    ),
  turn: () =>
    measured(() => {
      turnStore.update((turn) => turn + 1)
      return Promise.resolve()
    }),
  after,
}
;(window as unknown as { bench: Bench }).bench = bench
