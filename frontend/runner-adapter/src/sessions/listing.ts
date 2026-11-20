import { sessionName } from "@novadeck/core/session-name"
import type { Project } from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/runner-client"

import type { RunnerListing } from "./seed"

type Listed = Pick<Runner, "sessions" | "terminals" | "companions">

// Lists one project's sessions, terminals and companions as the runner holds them now. A project
// without a session gets one, so the workspace can open it. A project removed meanwhile, as
// from another window, is none.
export const listProject = async (
  runner: Listed,
  project: Project,
  newId: () => string,
  now: () => number,
): Promise<RunnerListing[number] | undefined> => {
  try {
    const found = await runner.sessions.list({ projectId: project.id })
    const sessions = found.length
      ? found
      : [
          await runner.sessions.create({
            id: newId(),
            projectId: project.id,
            name: sessionName(now()),
          }),
        ]
    return {
      project,
      sessions: await Promise.all(
        sessions.map(async (session) => {
          const [terminals, companions] = await Promise.all([
            runner.terminals.list({ sessionId: session.id }),
            runner.companions.list({ sessionId: session.id }),
          ])
          return { session, terminals, companions }
        }),
      ),
    }
  } catch (error) {
    if (hasCode(error, "NOT_FOUND")) return undefined
    throw error
  }
}
