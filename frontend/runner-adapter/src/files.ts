import type { ProjectFiles, FilesState } from "@novadeck/core/files"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"

// The runner's project folders as the Files panel reads them, each folder when it is asked
// for. The state stays empty: the panel's changes come from the runner's works instead. The
// repositories' sync with their origins is what the runner says of it (`projects.sync`, which a
// runner before revision 23 lacks: no repository is told of, asked of it each time, as the
// handshake may not have said yet).
export const createRunnerFiles = (
  projects: Pick<Runner["projects"], "folder" | "sync" | "syncSeen" | "updateCheckout">,
  supports: (path: "projects.sync") => boolean = () => true,
): ProjectFiles => ({
  state: createStore<FilesState>({ projects: {} }),
  list: (projectId, folder) => projects.folder({ projectId, folder }),
  sync: async (projectId) =>
    supports("projects.sync") ? projects.sync({ projectId }) : { repos: [] },
  seen: async (projectId, path, to) => {
    if (supports("projects.sync"))
      await projects.syncSeen({ projectId, path, ...(to !== undefined && { to }) })
  },
  update: (projectId, path) =>
    projects.updateCheckout({ projectId, ...(path !== undefined && { path }) }),
})
