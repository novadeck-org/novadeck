import type { Source, SourceState } from "@novadeck/core/source"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"

// The runner's project folders as the Source panel reads them, each folder when it is asked
// for. The state stays empty: the panel's changes come from the runner's works instead.
export const createRunnerSource = (projects: Pick<Runner["projects"], "folder">): Source => {
  const state = createStore<SourceState>({ projects: {} })
  return {
    state,
    list: (projectId, folder) => projects.folder({ projectId, folder }),
  }
}
