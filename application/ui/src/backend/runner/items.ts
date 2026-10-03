import type {
  CompanionItem as RunnerItem,
  CompanionWindow as RunnerWindow,
} from "@novadeck/protocol"
import { hasCode, type CompanionWatchItem, type Runner } from "@novadeck/protocol/client"

import type { ItemId } from "../../model/companion"
import { hasWindow } from "../../model/roster"
import type { WorkspaceAction } from "../../model/state"
import type { Workspace, WorkspaceTarget } from "../../model/types"
import type { BackendAction } from "../port"
import { itemOf, windowOf } from "./companions"
import type { RunnerListing } from "./seed"

// The runner's companion items and windows, kept in step with the workspace: what the
// runner reports reaches the store as `item/*` and `window/*` actions, and what the
// person does to them reaches the runner in the order they did it, each once the
// session exists there. A call the runner refuses puts back what it last confirmed.

export type ItemsApi = Pick<
  Runner["companions"],
  "watch" | "move" | "undock" | "close" | "renameWindow" | "resetWindowTitle"
>

export type RunnerItems = {
  // The person's changes to items and windows, as a commit carries them.
  readonly commit: (actions: readonly WorkspaceAction[]) => void
  // Follows the runner's items and windows; returns the stop.
  readonly watch: () => () => void
  // Gives a window its item's name again.
  readonly resetWindow: (target: WorkspaceTarget, windowId: string) => void
  // Whether the workspace holds a window by this id.
  readonly holdsWindow: (target: WorkspaceTarget, id: string) => boolean
}

// Equal when both say the same, whatever order their fields came in.
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, each]) => [key, canonical(each)]),
        )
      : value
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const onBarOf = (item: RunnerItem, terminalId: string): boolean =>
  "terminalId" in item.holder && item.holder.terminalId === terminalId

// What a file or page item points at; a plan's slot is the runner's to know.
const pointerOf = (item: RunnerItem): string | null =>
  item.kind === "plan" ? null : item.kind === "page" ? `page:${item.url}` : `file:${item.path}`

export const createRunnerItems = ({
  runner,
  listing,
  latest,
  ready,
  terminalReady,
  call,
  dispatch,
  consume,
}: {
  readonly runner: ItemsApi
  readonly listing: RunnerListing
  readonly latest: () => Workspace | undefined
  // Resolves whether the session exists on the runner.
  readonly ready: (sessionId: string) => Promise<boolean>
  // Resolves whether the terminal exists on the runner, once this window created it.
  readonly terminalReady: (terminalId: string) => Promise<boolean>
  // Calls the runner until it answers; rejects with what it refused, or once the work is
  // no longer wanted.
  readonly call: <T>(
    operation: () => Promise<T>,
    done: readonly ("NOT_FOUND" | "CONFLICT")[],
  ) => Promise<T | undefined>
  readonly dispatch: (actions: readonly BackendAction[]) => void
  readonly consume: <T>(changes: AsyncIterable<T>, handle: (change: T) => void) => Promise<void>
}): RunnerItems => {
  const listed = listing.flatMap(({ sessions }) =>
    sessions.flatMap(({ companions }) => companions ?? []),
  )
  // What the runner last confirmed of each item and window.
  const items = new Map<string, RunnerItem>(
    listed.flatMap(({ items: each }) => each.map((item) => [item.id, item])),
  )
  const windows = new Map<string, RunnerWindow>(
    listed.flatMap(({ windows: each }) => each.map((window) => [window.id, window])),
  )
  // Windows held back until the item they show reaches the store: the workspace never
  // holds a window without its item. The seed leaves out the same ones.
  const held = new Map<string, RunnerWindow>(
    [...windows].filter(([, window]) => !items.has(window.itemId)),
  )

  // The workspace's place for a runner session, while the workspace holds it.
  const targetOf = (sessionId: string): WorkspaceTarget | undefined => {
    const project = latest()?.projects.find((each) =>
      each.history.some((session) => session.id === sessionId),
    )
    return project && { projectId: project.id, workspaceSessionId: sessionId }
  }
  const stateOf = (target: WorkspaceTarget) =>
    latest()
      ?.projects.find((project) => project.id === target.projectId)
      ?.history.find((session) => session.id === target.workspaceSessionId)?.state
  const storedItem = (target: WorkspaceTarget, id: string) =>
    stateOf(target)?.items.find((item) => item.id === id)
  const storedWindow = (target: WorkspaceTarget, id: string) =>
    stateOf(target)?.roster.windows.find((window) => window.id === id)

  // The item as the runner reports it, where the store holds it otherwise.
  const itemUpsert = (item: RunnerItem): BackendAction[] => {
    const target = targetOf(item.sessionId)
    if (!target || same(storedItem(target, item.id), itemOf(item))) return []
    return [{ type: "item/upsert", target, item: itemOf(item) }]
  }
  // The window as the runner reports it, once the store holds its item, or `arriving`
  // brings it along; held back until then.
  const windowUpsert = (
    window: RunnerWindow,
    arriving: (itemId: string) => boolean = () => false,
  ): BackendAction[] => {
    const target = targetOf(window.sessionId)
    if (!target) return []
    if (!arriving(window.itemId) && !storedItem(target, window.itemId)) {
      held.set(window.id, window)
      return []
    }
    held.delete(window.id)
    return same(storedWindow(target, window.id), windowOf(window))
      ? []
      : [{ type: "window/upsert", target, window: windowOf(window) }]
  }
  // Dispatches the item's upsert, then shows the windows that waited for it.
  const deliverItem = (item: RunnerItem): void => {
    dispatch(itemUpsert(item))
    const waiting = [...held.values()].filter((window) => window.itemId === item.id)
    for (const window of waiting) dispatch(windowUpsert(window))
  }

  // A round that lists everything again, applied at `synced` against what the store
  // holds, so whatever drifted there, as after a refused call, comes back as listed.
  let round: { items: Map<string, RunnerItem>; windows: Map<string, RunnerWindow> } | undefined
  const resync = (next: NonNullable<typeof round>): void => {
    items.clear()
    windows.clear()
    held.clear()
    for (const [id, item] of next.items) items.set(id, item)
    for (const [id, window] of next.windows) windows.set(id, window)
    // What the store holds that the runner no longer lists goes first: an item's removal
    // takes its window with it, which the round may list again, holding another.
    const removed = (latest()?.projects ?? []).flatMap((project) =>
      project.history.flatMap((session): BackendAction[] => {
        const target = { projectId: project.id, workspaceSessionId: session.id }
        return [
          ...session.state.items.flatMap((item): BackendAction[] =>
            next.items.has(item.id) ? [] : [{ type: "item/remove", target, itemId: item.id }],
          ),
          ...session.state.roster.windows.flatMap((window): BackendAction[] =>
            next.windows.has(window.id)
              ? []
              : [{ type: "window/remove", target, windowId: window.id }],
          ),
        ]
      }),
    )
    // Applied whole: the listed items, then the windows showing them.
    dispatch([
      ...removed,
      ...[...next.items.values()].flatMap(itemUpsert),
      ...[...next.windows.values()].flatMap((window) =>
        windowUpsert(window, (itemId) => next.items.has(itemId)),
      ),
    ])
  }

  const onChange = (change: CompanionWatchItem): void => {
    if (change.type === "reset") {
      round = { items: new Map(), windows: new Map() }
      return
    }
    if (round && change.type === "item") return void round.items.set(change.item.id, change.item)
    if (round && change.type === "window")
      return void round.windows.set(change.window.id, change.window)
    if (round && change.type === "synced") {
      const next = round
      round = undefined
      return resync(next)
    }
    if (change.type === "item") {
      items.set(change.item.id, change.item)
      return deliverItem(change.item)
    }
    if (change.type === "window") {
      windows.set(change.window.id, change.window)
      return dispatch(windowUpsert(change.window))
    }
    if (change.type === "itemRemoved") {
      items.delete(change.itemId)
      const target = targetOf(change.sessionId)
      return dispatch(
        target ? [{ type: "item/remove", target, itemId: change.itemId as ItemId }] : [],
      )
    }
    if (change.type === "windowRemoved") {
      windows.delete(change.windowId)
      held.delete(change.windowId)
      const target = targetOf(change.sessionId)
      return dispatch(target ? [{ type: "window/remove", target, windowId: change.windowId }] : [])
    }
  }

  // The item as the runner last confirmed it, and its window, or its removal when the
  // runner has it no longer.
  const confirmed = (target: WorkspaceTarget, itemId: string): BackendAction[] => {
    const item = items.get(itemId)
    if (!item) return [{ type: "item/remove", target, itemId: itemId as ItemId }]
    const window = "windowId" in item.holder ? windows.get(item.holder.windowId) : undefined
    return [
      // Put back, it doesn't open again on its own.
      { type: "item/upsert", target, item: { ...itemOf(item), asked: false } },
      ...(window ? [{ type: "window/upsert", target, window: windowOf(window) } as const] : []),
    ]
  }
  const confirmedWindow = (target: WorkspaceTarget, windowId: string): BackendAction[] => {
    const window = windows.get(windowId)
    return window ? [{ type: "window/upsert", target, window: windowOf(window) }] : []
  }
  // What the target bar held under the same pointer as the item, which moving it there
  // replaces.
  const twinsOf = (itemId: string, terminalId: string): RunnerItem[] => {
    const item = items.get(itemId)
    const pointer = item && pointerOf(item)
    return pointer
      ? [...items.values()].filter(
          (each) => each.id !== itemId && onBarOf(each, terminalId) && pointerOf(each) === pointer,
        )
      : []
  }

  // The person's changes reach the runner one at a time, in the order they made them.
  let queue: Promise<unknown> = Promise.resolve()
  const send = <T>(
    target: WorkspaceTarget,
    operation: () => Promise<T>,
    {
      done = [],
      before = async () => {},
      answered = () => {},
      refused,
    }: {
      readonly done?: readonly ("NOT_FOUND" | "CONFLICT")[]
      // Waits for what the call needs on the runner, as the terminal it moves to.
      readonly before?: () => Promise<unknown>
      readonly answered?: (result: T | undefined) => void
      readonly refused: () => BackendAction[]
    },
  ): void => {
    queue = queue
      .then(() => ready(target.workspaceSessionId))
      .then(async (ok) => {
        if (!ok) throw new Error("The runner could not create this session.")
        await before()
        answered(await call(operation, done))
      })
      .catch(() => dispatch(refused()))
  }

  // Moves onto a terminal once the runner has it; one it didn't have yet, as while a
  // fresh shell started, is tried again once it does.
  const move = (itemId: string, terminalId: string) => async () => {
    try {
      return await runner.move(itemId, terminalId)
    } catch (error) {
      if (!hasCode(error, "TERMINAL_NOT_FOUND") || !(await terminalReady(terminalId))) throw error
      return runner.move(itemId, terminalId)
    }
  }

  const commit = (actions: readonly WorkspaceAction[]): void => {
    for (const action of actions) {
      if (action.type === "item/move")
        for (const itemId of action.itemIds) {
          // What the move replaces on the bar it goes to, as the runner last confirmed it.
          const twins = twinsOf(itemId, action.terminalId)
          send(action.target, move(itemId, action.terminalId), {
            before: () => terminalReady(action.terminalId),
            answered: (item) => {
              if (!item) return
              const left = items.get(itemId)
              if (left && "windowId" in left.holder) windows.delete(left.holder.windowId)
              for (const twin of twins) items.delete(twin.id)
              items.set(item.id, item)
            },
            refused: () => [
              ...confirmed(action.target, itemId),
              ...twins.flatMap((twin) => confirmed(action.target, twin.id)),
            ],
          })
        }
      if (action.type === "item/undock") {
        const { itemId, window } = action
        send(action.target, () => runner.undock(itemId, window.id), {
          answered: (made) => {
            if (!made) return
            windows.set(made.id, made)
            const item = items.get(itemId)
            if (item) items.set(itemId, { ...item, holder: { windowId: made.id } })
          },
          refused: () => [
            { type: "window/remove", target: action.target, windowId: window.id },
            ...confirmed(action.target, itemId),
          ],
        })
      }
      if (action.type === "item/close")
        send(action.target, () => runner.close(action.itemId), {
          done: ["NOT_FOUND"],
          answered: () => items.delete(action.itemId),
          refused: () => confirmed(action.target, action.itemId),
        })
      if (action.type === "terminal/rename" && holdsWindow(action.target, action.terminalId))
        send(action.target, () => runner.renameWindow(action.terminalId, action.name), {
          refused: () => confirmedWindow(action.target, action.terminalId),
        })
    }
  }

  const holdsWindow = (target: WorkspaceTarget, id: string): boolean => {
    const roster = stateOf(target)?.roster
    return roster !== undefined && hasWindow(roster, id)
  }

  return {
    commit,
    watch: () => {
      const changes = runner.watch()
      void consume(changes, onChange)
      return () => void changes.return?.()
    },
    resetWindow: (target, windowId) =>
      send(target, () => runner.resetWindowTitle(windowId), {
        done: ["NOT_FOUND"],
        refused: () => confirmedWindow(target, windowId),
      }),
    holdsWindow,
  }
}
