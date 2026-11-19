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
import {
  changedIn,
  changedPaths,
  handleOf,
  makeProject,
  rootOf,
  seedPaths,
  terminalOf,
  workOf,
  type Config,
} from "../scenario.ts"
import type { Bench, Timed } from "../summary.ts"

const config = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Config
const projectId = "bench"
const project = makeProject(config)
const edits = changedPaths(project, config)

// The runner's `works.watch` items, handed over as the bench pushes them.
type Item = { type: string; [key: string]: unknown }
const queue: Item[] = []
let waiting: ((item: IteratorResult<Item, undefined>) => void) | undefined
const push = (...items: Item[]): void => {
  queue.push(...items)
  const wake = waiting
  waiting = undefined
  const next = queue.shift()
  if (wake && next) wake({ done: false, value: next })
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
const { works } = createRunnerWorks({
  watch: () => stream,
  made: () => never,
} as unknown as Parameters<typeof createRunnerWorks>[0])

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
const list = (folder: string): Promise<FolderListing> => {
  reads += 1
  const listing = project.listings.get(folder)
  return listing ? Promise.resolve(listing) : Promise.reject(new Error(`no folder ${folder}`))
}

const turnStore = createStore(0)
const squads: readonly (readonly string[])[] = []
const noop = (): void => {}
const openFile = (): Promise<void> => Promise.resolve()

let commits = 0
let reactMs = 0
const onRender: ProfilerOnRenderCallback = (_id, _phase, actual) => {
  commits += 1
  reactMs += actual
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

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

const longTasks: number[] = []
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) longTasks.push(entry.duration)
})
observer.observe({ type: "longtask", buffered: false })

// Two frames with nothing to do in them: the events are all handled, no folder read is out and
// no commit came in the last two frames, so the frame after the last work has been painted.
const settle = async (): Promise<void> => {
  const deadline = performance.now() + 60_000
  for (;;) {
    const before = commits
    // oxlint-disable-next-line no-await-in-loop -- Frames come one after another.
    await frame()
    // oxlint-disable-next-line no-await-in-loop -- As above.
    await frame()
    if (drained() && commits === before) return
    if (performance.now() > deadline) throw new Error("the panel didn't settle in 60 s")
  }
}

const rows = (): number => document.querySelectorAll('[role="tree"] [data-path]').length
const synced = (): Item[] => (config.synced ? [{ type: "synced" }] : [])

const measured = async (start: () => void): Promise<Timed> => {
  commits = 0
  reactMs = 0
  reads = 0
  observer.takeRecords()
  longTasks.length = 0
  const from = performance.now()
  start()
  await settle()
  const wallMs = performance.now() - from
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const entry of observer.takeRecords()) longTasks.push(entry.duration)
  return { wallMs, longTasks: [...longTasks], commits, reactMs, reads, rows: rows() }
}

const ready = (async () => {
  works.watch()
  // The seed work leaves a change in every folder, so the panel opens them all on first sight
  // of the root; it is let go below, and the folders stay open.
  const now = Date.now()
  push(
    { type: "reset" },
    { type: "changed", work: workOf(-1, seedPaths(project), now, projectId) },
    ...edits.map((paths, index) => ({
      type: "changed",
      work: workOf(index, paths, now, projectId),
    })),
    { type: "synced" },
  )
  await settle()
  const root = document.getElementById("root")!
  createRoot(root).render(
    <Profiler id="bench" onRender={onRender}>
      <Harness />
    </Profiler>,
  )
  await settle()
  push({ type: "removed", root: "/work/seed", projectId })
  await settle()
})()

const bench: Bench = {
  ready,
  poll: (poll) =>
    measured(() =>
      push(
        ...changedIn(poll, config).map((index) => ({
          type: "changed",
          work: workOf(index, edits[index]!, Date.now(), projectId),
        })),
        ...synced(),
      ),
    ),
  turn: () => measured(() => turnStore.update((turn) => turn + 1)),
}
;(window as unknown as { bench: Bench }).bench = bench
