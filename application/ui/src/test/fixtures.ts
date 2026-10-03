import { itemIdOf, type CompanionItem } from "../model/companion"
import { createTerminalState, workspaceReducer, type WorkspaceAction } from "../model/state"
import type { TerminalMetadata, ViewMode, Workspace } from "../model/types"

// A plain shell terminal numbered like the ones a person creates.
export const terminalFixture = (number: number, directory: string): TerminalMetadata => {
  const id = String(number).padStart(2, "0")
  return {
    id,
    name: `Terminal ${id}`,
    directory,
    command: "zsh",
    process: "zsh",
    state: "idle",
  }
}

// Something terminal `terminalId`'s agent showed on its own bar: a file named for `id`,
// shown once, unless `item` says otherwise.
export const itemFixture = (
  id: string,
  terminalId: string,
  item: Partial<CompanionItem> = {},
): CompanionItem => ({
  id: itemIdOf(id),
  holder: { terminalId },
  kind: "file",
  name: `${id}.ts`,
  detail: `src/${id}.ts`,
  path: `/project/src/${id}.ts`,
  url: null,
  lines: null,
  held: false,
  by: "agent",
  from: { terminalId, handle: `t${Number(terminalId)}` },
  version: 1,
  asked: false,
  shownAt: 0,
  plan: null,
  ...item,
})

// One project with workspace sessions named by `sessions`, each holding `terminals`
// numbered terminals and showing `view`. The first session is active.
export const workspaceFixture = ({
  terminals = 2,
  view = "grid",
  sessions = ["initial"],
}: { terminals?: number; view?: ViewMode; sessions?: string[] } = {}): Workspace => ({
  activeProjectId: "project",
  projects: [
    {
      id: "project",
      name: "Project",
      directory: "~/project",
      activeSessionId: sessions[0]!,
      history: sessions.map((id) => ({
        id,
        name: id,
        visitedAt: 0,
        state: createTerminalState(
          Array.from({ length: terminals }, (_, index) => terminalFixture(index + 1, "~/project")),
          view,
          view === "focus" ? "grid" : view,
        ),
      })),
    },
  ],
})

// The fixture's active session with terminal 01's file `hero` undocked into window `w1`,
// as its backend reports it, laid out after the terminals.
export const workspaceWithWindow = (
  options?: Parameters<typeof workspaceFixture>[0],
): Workspace => {
  const target = { projectId: "project", workspaceSessionId: "initial" }
  const hero = itemFixture("hero", "01", { holder: { windowId: "w1" } })
  const actions: WorkspaceAction[] = [
    { type: "item/upsert", target, item: hero },
    {
      type: "window/upsert",
      target,
      window: { id: "w1", itemId: hero.id, name: "hero.ts", titleSource: { kind: "default" } },
    },
  ]
  return actions.reduce(workspaceReducer, workspaceFixture(options))
}
