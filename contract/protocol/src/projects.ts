import { z } from "zod"

import { directory, id, name } from "./fields.js"
import { openUnion } from "./open.js"

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
// main strictly ahead of it and the runner hasn't moved it: it has changes of its own, an
// operation half done, a file in the way, or it was not fetched since; `count` is how many commits
// main has that it lacks. `moved` counts the times the runner moved the checkout to main since it
// began, and `head` is the commit HEAD is at (null where there is none): when either changes, the
// files on disk may have.
export const checkoutState = z.strictObject({
  behind: z.strictObject({ branch: name, remote: name, count: z.number().int().min(1) }).nullable(),
  moved: z.number().int().min(0),
  head: z.string().max(128).nullable(),
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
  // Raised by every change to the session (its state, name or place), so the clients that
  // share it can tell a newer one from what they hold. Absent from a runner from before it.
  revision: z.number().int().nonnegative().optional(),
})

// A place in a session's state as JSON: its object keys, outermost first.
const sessionPath = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((key) => key !== "__proto__", "Not a key a state holds"),
  )
  .min(1)
  .max(8)

/**
 * A change to a session's state, as JSON the runner holds without reading what it means: each
 * `unset` path taken out, then each `set` path given its value whole, any objects on the way
 * there made. A client changes a state a record at a time (sessions/patch.ts in the runner
 * adapter), so two clients' changes to different records both keep.
 */
export const sessionPatch = z.strictObject({
  set: z.array(z.strictObject({ path: sessionPath, value: z.json() })).max(2048),
  unset: z.array(sessionPath).max(2048),
})

/**
 * What `sessions.watch` tells a client: first each session's revision, by id, to read again
 * those it holds older; then each session as it changes (`writer`, `base`: who changed it
 * and from which revision, where a `sessions.change` did; a session changed again before it
 * was read comes once, as it is now), and each one gone, those of a project removed among
 * them. A client from revision 5 drops a kind it doesn't know.
 */
export const sessionChange = openUnion(
  "type",
  [
    z.strictObject({
      type: z.literal("revisions"),
      revisions: z.record(id, z.number().int().nonnegative()),
    }),
    z.strictObject({
      type: z.literal("changed"),
      session: workspaceSession,
      writer: z.string().max(64).nullable(),
      base: z.number().int().nonnegative().nullable(),
    }),
    z.strictObject({ type: z.literal("removed"), sessionId: id }),
  ],
  { since: 5, unknown: "drop" },
)

/**
 * What `projects.watch` tells a client: the projects as `projects.list` gives them, in the
 * person's order with each one's pin, first and again after each project is made, renamed,
 * arranged or removed; and a project's sessions in their order, once arranged. A reader slower
 * than the changes gets the latest of each only. A client drops a kind it doesn't know.
 */
export const projectsChange = openUnion(
  "type",
  [
    z.strictObject({ type: z.literal("projects"), projects: z.array(project).max(10_000) }),
    z.strictObject({
      type: z.literal("arranged"),
      projectId: id,
      order: z.array(id).max(10_000),
    }),
  ],
  { since: 5, unknown: "drop" },
)

export type Project = z.infer<typeof project>
export type SessionPatch = z.infer<typeof sessionPatch>
export type SessionChange = z.infer<typeof sessionChange>
export type ProjectsChange = z.infer<typeof projectsChange>
export type FolderListing = z.infer<typeof folderListing>
export type WorkspaceSession = z.infer<typeof workspaceSession>
