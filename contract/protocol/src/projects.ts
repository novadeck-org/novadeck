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

// The project's own checkout against its remote's main, as `projects.checkout` reports it.
// `behind` is set where the checkout is on the branch main is (`main` for `origin/main`) with
// main strictly ahead of it, which Novadeck leaves for the person when the checkout has changes of
// its own or an operation half done; `count` is how many commits main has that it lacks. `moved`
// counts the times the runner moved the checkout to main since it began: a change in it says the
// files on disk changed.
export const checkoutState = z.strictObject({
  behind: z.strictObject({ branch: name, remote: name, count: z.number().int().min(1) }).nullable(),
  moved: z.number().int().min(0),
})
export type CheckoutState = z.infer<typeof checkoutState>

// What `projects.updateCheckout` did: moved to main (or found it there already), or why not.
export const checkoutUpdate = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), said: z.string().max(300) }),
])
export type CheckoutUpdate = z.infer<typeof checkoutUpdate>

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
