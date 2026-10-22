import type { Source, SourceState } from "@novadeck/core/source"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"

// The runner's project folders as the Source panel reads them. A runner tells of no
// changes to them, so the state stays empty, and each folder is read when it is asked for.
export const createRunnerSource = (projects: Pick<Runner["projects"], "folder">): Source => {
  const state = createStore<SourceState>({ projects: {} })
  return {
    state,
    list: (projectId, folder) => projects.folder({ projectId, folder }),
  }
}
