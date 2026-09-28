import { createTerminalState } from "../model/state"
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
