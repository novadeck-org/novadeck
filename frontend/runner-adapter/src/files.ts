import type { ProjectFiles, FilesState } from "@novadeck/core/files"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"

// The runner's project folders as the Files panel reads them, each folder when it is asked
// for. The state stays empty: the panel's changes come from the runner's works instead.
export const createRunnerFiles = (
  projects: Pick<Runner["projects"], "folder" | "checkout" | "updateCheckout">,
): ProjectFiles => {
  const state = createStore<FilesState>({ projects: {} })
  return {
    state,
    list: (projectId, folder) => projects.folder({ projectId, folder }),
    checkout: (projectId) => projects.checkout({ projectId }),
    update: (projectId) => projects.updateCheckout({ projectId }),
  }
}
