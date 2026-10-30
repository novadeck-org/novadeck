import { z } from "zod"

import { directory, id, name } from "./fields.js"

/**
 * The longest saved session state, in characters. Over WebSocket, the whole
 * `sessions.save` call must also fit in `maxWebSocketMessageBytes`.
 */
export const maxClientStateLength = 196_608

// Opaque client-owned state the runner stores without reading, such as a UI layout.
export const clientState = z.string().max(maxClientStateLength)

// `pinned` when the person pinned it in the switcher; `projects.list` gives their order.
export const project = z.strictObject({ id, name, cwd: directory, pinned: z.boolean() })

// One folder of a project's directory, as `projects.folder` lists it: each entry by its own
// name, and whether git ignores it. `truncated` says the folder holds more than is listed.
export const folderListing = z.strictObject({
  entries: z.array(
    z.strictObject({
      name: z.string().min(1).max(4096),
      folder: z.boolean(),
      ignored: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
})
export const workspaceSession = z.strictObject({
  id,
  projectId: id,
  name,
  // Last value saved with `sessions.save`, or null before the first save.
  state: clientState.nullable(),
  // When the person last visited it, as last saved with `sessions.save`; null before. The
  // latest visit picks a project's current session, and the latest of all the project open.
  visitedAt: z.number().nullable(),
})

export type Project = z.infer<typeof project>
export type FolderListing = z.infer<typeof folderListing>
export type WorkspaceSession = z.infer<typeof workspaceSession>
