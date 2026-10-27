import { WorkspaceStore } from "../workspaces/store.js"

/**
 * A store at `path` holding the project and session that rows written under them need: a
 * row's project or session must exist. A reopened store keeps them as they are.
 */
export const storeWith = (
  path: string,
  { projectId, sessionId }: { readonly projectId: string; readonly sessionId: string },
): WorkspaceStore => {
  const store = new WorkspaceStore(path)
  const database = store["database"]
  database
    .prepare("INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, 'Project', '/')")
    .run(projectId)
  database
    .prepare("INSERT OR IGNORE INTO sessions (id, project_id, name) VALUES (?, ?, 'Session')")
    .run(sessionId, projectId)
  return store
}
