import { z } from "zod"

import { agentName } from "./agents.js"
import { id } from "./fields.js"
import { handle, terminalTitle } from "./terminals.js"

// What agents show and the person attaches beside a terminal: a pointer to a file, a
// page or a plan, never a copy of it, which `companions.content` reads when it loads.
// Each item has one holder, a terminal's bar or a window; `from` is the terminal it was
// shown or attached in, null for a file the person opened in their project window, which
// came from no terminal. `version` counts its shows, `openAsked` says the
// latest one asked to open it, and `secret` marks a file that may hold secrets, which
// opens only when the person picks it. A plan names its agent, its actor's role, and
// whether it is a file or text in the agent's own transcript or rollout.
const itemHolder = z.union([z.strictObject({ terminalId: id }), z.strictObject({ windowId: id })])
export const companionItem = z.strictObject({
  id,
  sessionId: id,
  holder: itemHolder,
  kind: z.enum(["image", "file", "page", "plan", "changes"]),
  name: z.string().max(256),
  detail: z.string().max(512),
  path: z.string().max(4096).nullable(),
  url: z.string().max(8192).nullable(),
  lines: z.strictObject({ from: z.int().min(1), to: z.int().min(1) }).nullable(),
  secret: z.boolean(),
  by: z.enum(["agent", "person"]),
  from: z.strictObject({ terminalId: id, handle }).nullable(),
  version: z.int().min(1),
  openAsked: z.boolean(),
  shownAt: z.number(),
  plan: z
    .strictObject({
      agent: agentName,
      role: z.enum(["root", "subagent"]),
      source: z.enum(["file", "text"]),
    })
    .nullable(),
})

// A window holding one item, named by the client that made it: an item undocked from a
// bar, or the session's project window, the one the person opens files in (`home`). Its
// title is the person's, or by default the item's name.
export const companionWindow = z.strictObject({
  id,
  sessionId: id,
  home: z.enum(["undocked", "project"]),
  itemId: id,
  title: terminalTitle,
  titleSource: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("person") }),
    z.strictObject({ kind: z.literal("default") }),
  ]),
})

// `companions.watch` events: every item and window, `synced`, then each later change.
export const companionChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item"), item: companionItem }),
  z.strictObject({ type: z.literal("itemRemoved"), itemId: id, sessionId: id }),
  z.strictObject({ type: z.literal("window"), window: companionWindow }),
  z.strictObject({ type: z.literal("windowRemoved"), windowId: id, sessionId: id }),
  // Follows the initial events: items and windows not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

// `companions.save`: the plan's new stamp, or, when it changed since the stamp the edit was
// made on, the plan as it now stands.
export const planSaveResult = z.discriminatedUnion("saved", [
  z.strictObject({ saved: z.literal(true), stamp: z.string().max(128) }),
  z.strictObject({
    saved: z.literal(false),
    current: z.strictObject({
      stamp: z.string().max(128),
      text: z.string().max(256 * 1024),
      truncated: z.boolean(),
      // As in the plan's content.
      skill: z.boolean(),
    }),
  }),
])

// `companions.pageTrouble` items: what went wrong on a page an agent showed, as the desktop
// pane saw it while the page was at the address's origin it was shown at. An `error` the
// page logged or threw, with the script and line it came from (0 when unknown); a
// `request` of the page's own origin, the page itself or what it loaded (`what`: "page",
// "script", "fetch", "img"…), answered with an HTTP error `status`, or 0 for none at all;
// or a `load` of the page that failed outright, with Chromium's error, as a server that
// isn't running.
export const pageTrouble = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("error"),
    text: z.string().max(1024),
    source: z.string().max(2048),
    line: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal("request"),
    url: z.string().max(2048),
    status: z.int().min(0).max(999),
    what: z.string().max(32),
  }),
  z.strictObject({ kind: z.literal("load"), text: z.string().max(256) }),
])

/** How many troubles one `companions.pageTrouble` call carries at most. */
export const maxPageTroubles = 20

// `companions.looks` items: an agent's look, through Novadeck's MCP server, at a page item
// it may look at, for the client to picture: the item, its latest show (its version) and
// the address that show pointed at. A pane still showing an earlier show isn't pictured.
export const pageLook = z.strictObject({
  lookId: id,
  itemId: id,
  shown: z.int().min(1),
  url: z.string().max(2048),
})

/** The largest picture a look is answered with: a JPEG data URL, in characters. */
export const maxLookPicture = 4 * 1024 * 1024

// The client's answer to a look: a JPEG picture of the page; where it was then, its address
// and title; how it was taken, `pane` as the person's pane shows it now, or `fresh`, its
// address loaded anew at the pane's size, as no pane shows it live; the size it laid out at,
// in CSS pixels; and what went wrong on a fresh load. Or why there's none, in a sentence the
// agent can pass on.
export const pageLookAnswer = z.union([
  z.strictObject({
    lookId: id,
    picture: z.string().max(maxLookPicture).startsWith("data:image/jpeg;base64,"),
    url: z.string().max(2048),
    title: z.string().max(1024),
    taken: z.enum(["pane", "fresh"]),
    size: z.strictObject({ width: z.int().min(1).max(8192), height: z.int().min(1).max(8192) }),
    troubles: z.array(pageTrouble).max(maxPageTroubles),
  }),
  z.strictObject({ lookId: id, reason: z.string().trim().min(1).max(512) }),
])

/** Bounds of a change as `companions.content` carries it: files, and the diff text in all. */
export const maxChangedFiles = 300
export const maxChangesBytes = 4 * 1024 * 1024

// One file of a change: its path (and its old one when renamed), how it changed, how many
// lines were added and removed, and its diff as hunks of lines, each with a line's kind and
// text. A `binary` file, one that may hold secrets (`secret`), or one past the change's bounds
// (`listed`) has no hunks: it is listed by name. Line numbers count from each hunk's start.
const changedFile = z.strictObject({
  path: z.string().max(4096),
  oldPath: z.string().max(4096).nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  binary: z.boolean(),
  secret: z.boolean(),
  listed: z.boolean(),
  hunks: z.array(
    z.strictObject({
      oldStart: z.int().nonnegative(),
      oldCount: z.int().nonnegative(),
      newStart: z.int().nonnegative(),
      newCount: z.int().nonnegative(),
      lines: z.array(
        z.strictObject({
          kind: z.enum(["context", "add", "remove"]),
          text: z.string().max(4096),
        }),
      ),
    }),
  ),
})

// `companions.content`: what an item points at, read as it is now. `stamp` changes with
// it. A file is the lines around the ones pointed at, numbered from `firstLine`, with
// its line count where it was read to its end (`truncated` otherwise), and `clamped`
// when the lines pointed at ran past its end. A page is its address, which the desktop
// app loads live; `shown`, the item's version it was read at, counts the agent's shows,
// each of which loads it afresh, and `scroll` is the element that show brings into view.
// A change is the repository's working tree (staged, unstaged and untracked, not ignored)
// against `base`, file by file, up to `maxChangedFiles` and `maxChangesBytes` of diff text,
// past which files are listed by name and `truncated` says so; `root` is the repository's
// folder, which its paths are from. Or why it can't be shown, with the file's size where
// known.
export const itemContent = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    stamp: z.string().max(128),
    content: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("image"), src: z.string().max(12 * 1024 * 1024) }),
      z.strictObject({
        kind: z.literal("file"),
        path: z.string().max(4096),
        firstLine: z.int().min(1),
        lines: z.array(z.string().max(4096)).max(2000),
        from: z.int().min(1),
        to: z.int().min(1),
        total: z.int().nonnegative().nullable(),
        truncated: z.boolean(),
        clamped: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("page"),
        url: z.string().max(8192),
        shown: z.int().min(1),
        scroll: z.string().max(1024).optional(),
      }),
      z.strictObject({
        kind: z.literal("changes"),
        root: z.string().max(4096),
        base: z.string().max(256),
        files: z.array(changedFile).max(maxChangedFiles),
        truncated: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("plan"),
        text: z.string().max(256 * 1024),
        truncated: z.boolean(),
        changedAt: z.number().nullable(),
        // Whether `companions.save` can write it: a plan in a file, not one the agent
        // keeps in its transcript.
        writable: z.boolean(),
        // Whether Novadeck's plugin is installed into the plan's agent, which tells it to
        // re-read the plan and apply the notes left in it.
        skill: z.boolean(),
      }),
    ]),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum([
      "missing",
      "unreadable",
      "not-a-file",
      "too-large",
      "binary",
      "secret",
      "gone",
    ]),
    size: z.number().nullable(),
  }),
])

/**
 * Why `companions.save` can't write a plan, in `PLAN_UNWRITABLE`'s data, which retrying
 * won't change until the plan or its folder does:
 * - `gone`: the plan's file is no longer there.
 * - `folder`: Novadeck may not write in the plan's folder or file.
 * - `transcript`: the plan lives in an agent's messages, not a file.
 * - `too-large`: the plan is past what Novadeck writes (256 KiB).
 * - `not-a-plan`: the item is no plan.
 */
export const planUnwritable = z.strictObject({
  reason: z.enum(["gone", "folder", "transcript", "too-large", "not-a-plan"]),
})
export type PlanUnwritable = z.infer<typeof planUnwritable>

export type CompanionItem = z.infer<typeof companionItem>
export type CompanionWindow = z.infer<typeof companionWindow>
export type CompanionChange = z.infer<typeof companionChange>
export type ItemContent = z.infer<typeof itemContent>
export type PageTrouble = z.infer<typeof pageTrouble>
export type PageLook = z.infer<typeof pageLook>
export type PageLookAnswer = z.infer<typeof pageLookAnswer>
export type ChangedFile = z.infer<typeof changedFile>
export type PlanSaveResult = z.infer<typeof planSaveResult>
