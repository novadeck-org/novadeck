import type { FilesState } from "@novadeck/core/files"
import type { InboxAnswer } from "@novadeck/core/inbox"
import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import type { MutableStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import type { DemoInbox } from "../inbox"
import type { DemoMessages } from "../messages"
import type { DemoTour, TourShow, TourStage } from "../tour"
import type { DemoWorks } from "../works"
import { terminalOf } from "../workspace"
import type { Hero } from "./content"

// The story's stage, built as the first tour agent starts: what the agents show, write and say to
// each other, over what the demo's backend has. Apart from `tour.ts` so the demo that never plays
// the tour doesn't carry it.

// What an item the story showed holds: what its pane reads, and for a model its bytes, for
// changes the diffs of its files.
export type Held = {
  content: ItemContent
  bytes?: Uint8Array<ArrayBuffer> | undefined
  diffs?: TourShow["diffs"]
  item?: Item
}

// What the stage reads and changes of the backend that wraps it.
export type StageEnv = {
  readonly latest: () => Workspace | undefined
  readonly sink: () => BackendSink | undefined
  readonly tour: DemoTour
  readonly newTerminal: Backend["newTerminal"]
  readonly messages: DemoMessages | undefined
  readonly inbox: DemoInbox | undefined
  readonly answers: ReadonlyMap<string, InboxAnswer>
  readonly answerEntry: (id: string, answer: InboxAnswer) => void
  readonly works: DemoWorks | undefined
  readonly feed: MutableStore<FilesState> | undefined
  // The run's lead, where there is one.
  readonly lead: () => TerminalKey | undefined
  readonly setHero: (hero: Hero) => void
  readonly held: Map<string, Held>
  // Tells whoever follows an item what it holds now.
  readonly tell: (id: string) => void
}

const inSession = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// What the Files panel reads of a project's agents' writes, with `handle`'s write to `path`
// added or its cursor dropped.
const writing = (
  state: FilesState,
  projectId: string,
  handle: string,
  change: { readonly path: string; readonly kind: "added" | "modified" } | undefined,
  at: number,
): FilesState => {
  const project = state.projects[projectId] ?? { changes: {}, writing: {} }
  if (!change) {
    const { [handle]: _, ...rest } = project.writing
    return { projects: { ...state.projects, [projectId]: { ...project, writing: rest } } }
  }
  const was = project.changes[change.path]
  return {
    projects: {
      ...state.projects,
      [projectId]: {
        changes: {
          ...project.changes,
          [change.path]: {
            kind: was?.kind ?? change.kind,
            touched: { ...was?.touched, [handle]: at },
          },
        },
        writing: { ...project.writing, [handle]: change.path },
      },
    },
  }
}

export const createStage = (env: StageEnv): TourStage => {
  const itemOn = (key: TerminalKey, shown: TourShow, id: string, version: number): Item => ({
    id: itemIdOf(id),
    holder: { terminalId: key.terminalId },
    kind: shown.kind,
    name: shown.name,
    detail: shown.detail,
    path: shown.path,
    url: shown.url,
    lines: null,
    secret: false,
    by: "agent",
    from: { terminalId: key.terminalId, handle: terminalOf(env.latest(), key)?.handle ?? "" },
    version,
    openAsked: true,
    shownAt: Date.now(),
    plan: null,
  })
  const show = (key: TerminalKey, shown: TourShow): string => {
    const id = `tour-${shown.kind}-${key.terminalId}`
    const version = (env.held.get(id)?.item?.version ?? 0) + 1
    const item = itemOn(key, shown, id, version)
    env.held.set(id, { content: shown.content, bytes: shown.bytes, diffs: shown.diffs, item })
    env.sink()?.dispatch([{ type: "item/upsert", target: inSession(key), item }])
    env.tell(id)
    return id
  }
  const stage: TourStage = {
    workspace: () => env.latest(),
    newTerminal: (request) => env.newTerminal(request),
    messages: env.messages,
    inbox: env.inbox,
    answeredWith: (id) => env.answers.get(id),
    answerEntry: env.answerEntry,
    works: env.works,
    files: {
      write: (handle, path, kind) => {
        const projectId = env.lead()?.projectId
        if (projectId)
          env.feed?.update((state) => writing(state, projectId, handle, { path, kind }, Date.now()))
      },
      end: (handle) => {
        const projectId = env.lead()?.projectId
        if (projectId) env.feed?.update((state) => writing(state, projectId, handle, undefined, 0))
      },
    },
    approve: (from, command, cwd) => env.tour.approve(from, command, cwd),
    show,
    page: (key, content) => {
      const id = `tour-page-${key.terminalId}`
      const found = env.held.get(id)
      const url =
        content.state === "ready" && content.content.kind === "page" ? content.content.url : null
      if (!found) {
        show(key, {
          kind: "page",
          name: url?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "page",
          detail: "The game's dev server",
          path: null,
          url,
          content,
        })
        return
      }
      // Shown again: the page loads afresh, as the dev server reloads it by itself.
      const item = found.item && {
        ...found.item,
        version: found.item.version + 1,
        shownAt: Date.now(),
      }
      env.held.set(id, { ...found, content, ...(item && { item }) })
      if (item) env.sink()?.dispatch([{ type: "item/upsert", target: inSession(key), item }])
      env.tell(id)
    },
    update: (id, now) => {
      const found = env.held.get(id)
      if (!found) return
      env.held.set(id, { ...found, content: now.content, bytes: now.bytes ?? found.bytes })
      env.tell(id)
    },
    chose: (next) => {
      env.setHero(next)
    },
  }
  return stage
}
