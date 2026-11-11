import { z } from "zod"

import { agentName } from "./agents.js"
import { id } from "./fields.js"
import { handle, terminalTitle } from "./terminals.js"

// How long an item's name and detail, a path, a page's address and the element to bring into
// view run at most, in UTF-16 code units; how many lines of a file are read, each of at most
// `lineLength` (a diff's lines too); and how long a plan's text runs.
export const companionLimits = {
  name: 256,
  detail: 512,
  path: 4096,
  url: 8192,
  scroll: 1024,
  lines: 2000,
  lineLength: 4096,
  plan: 256 * 1024,
} as const

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
  name: z.string().max(companionLimits.name),
  detail: z.string().max(companionLimits.detail),
  path: z.string().max(companionLimits.path).nullable(),
  url: z.string().max(companionLimits.url).nullable(),
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
      text: z.string().max(companionLimits.plan),
      truncated: z.boolean(),
      // As in the plan's content.
      skill: z.boolean(),
    }),
  }),
])

// How long what a look and a page's troubles carry runs at most, in UTF-16 code units, which
// the client cuts to: the page's title, why a look has no picture, an error's text and the
// script it came from, a failed request's address and what it fetched, and a failed load's
// error. The address a look is at is a page item's, up to `companionLimits.url`.
export const lookLimits = {
  title: 1024,
  reason: 512,
  text: 1024,
  source: 2048,
  request: 2048,
  what: 32,
  load: 256,
} as const

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
    text: z.string().max(lookLimits.text),
    source: z.string().max(lookLimits.source),
    line: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal("request"),
    url: z.string().max(lookLimits.request),
    status: z.int().min(0).max(999),
    what: z.string().max(lookLimits.what),
  }),
  z.strictObject({ kind: z.literal("load"), text: z.string().max(lookLimits.load) }),
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
  url: z.string().max(companionLimits.url),
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
    url: z.string().max(companionLimits.url),
    title: z.string().max(lookLimits.title),
    taken: z.enum(["pane", "fresh"]),
    size: z.strictObject({ width: z.int().min(1).max(8192), height: z.int().min(1).max(8192) }),
    troubles: z.array(pageTrouble).max(maxPageTroubles),
  }),
  z.strictObject({ lookId: id, reason: z.string().trim().min(1).max(lookLimits.reason) }),
])

/**
 * Bounds of a change as `companions.content` carries it: files listed in all, the newest
 * layers (commits and the uncommitted work) and the files of each; and, in
 * `companions.changeFile`, the diff text of one file and the text of each side of it.
 */
export const maxChangedFiles = 300
export const maxChangeLayers = 100
export const maxLayerFiles = 2000
export const maxChangesBytes = 4 * 1024 * 1024
export const maxChangeSideBytes = 512 * 1024

// One file a layer changed: its path (and its old one when renamed), how it changed, and
// how many lines were added and removed. Lines that differ from their old ones only by
// whitespace are no change: they are counted apart, as `reindented` (the lines of the new
// side). A `binary` file, or one that may hold secrets (`secret`), is listed by name; its
// content is never read.
const changedFile = z.strictObject({
  path: z.string().max(companionLimits.path),
  oldPath: z.string().max(companionLimits.path).nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  reindented: z.int().nonnegative(),
  binary: z.boolean(),
  secret: z.boolean(),
})

// One layer of a change: a commit since the checkout's merge base with main (`id` is its
// hash), or the work not committed yet (`id` is "uncommitted"; its `time` is null). Its
// files, up to `maxChangedFiles`, with `truncated` when more changed; `added` and `removed`
// count all of them.
export const uncommittedLayer = "uncommitted"
const changeLayer = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(["commit", "uncommitted"]),
  subject: z.string().max(companionLimits.name),
  time: z.number().nullable(),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  files: z.array(changedFile).max(maxChangedFiles),
  truncated: z.boolean(),
  // A merge shown against its first parent, as the runner's git can't merge in memory (before
  // 2.38): what it brought in from main shows as its work.
  firstParent: z.boolean().optional(),
})

// A file's diff as hunks of lines, each with a line's kind and text. Line numbers count
// from each hunk's start.
const diffHunk = z.strictObject({
  oldStart: z.int().nonnegative(),
  oldCount: z.int().nonnegative(),
  newStart: z.int().nonnegative(),
  newCount: z.int().nonnegative(),
  lines: z.array(
    z.strictObject({
      kind: z.enum(["context", "add", "remove"]),
      text: z.string().max(companionLimits.lineLength),
    }),
  ),
})

// `companions.changeRange`: the files a selection of layers changed as one range, as git
// lists them from the range's start to its end: a file added and deleted inside it is not
// there, one renamed is one row, and its counts are the range's own, not the layers' added up.
export const changeRange = z.strictObject({
  files: z.array(changedFile).max(maxChangedFiles),
  truncated: z.boolean(),
})

// `companions.changeFile`: one file as a selection of layers changed it. The selection is
// one range (from the oldest layer's parent to the newest), so one run; `null` where it did
// not change the file. A run has its file's diff as hunks (none, with `big`, where the
// diff passes the bounds) and the text of the file on each side of the range, which the
// client reads facts from: null where a side does not exist (a file added or deleted),
// where it passes `maxChangeSideBytes`, or where the file is binary or may hold secrets.
export const changeFileDiff = z.strictObject({
  run: z
    .strictObject({
      layers: z.array(z.string().min(1).max(128)).min(1).max(maxChangeLayers),
      file: changedFile,
      big: z.boolean(),
      // Its name is no valid text, which git can't be given back: it is named, not read.
      badName: z.boolean(),
      hunks: z.array(diffHunk),
      before: z.string().max(maxChangeSideBytes).nullable(),
      after: z.string().max(maxChangeSideBytes).nullable(),
    })
    .nullable(),
})

// `companions.content`: what an item points at, read as it is now. `stamp` changes with
// it. A file is the lines around the ones pointed at, numbered from `firstLine`, with
// its line count where it was read to its end (`truncated` otherwise), and `clamped`
// when the lines pointed at ran past its end. A page is its address, which the desktop
// app loads live; `shown`, the item's version it was read at, counts the agent's shows,
// each of which loads it afresh, and `scroll` is the element that show brings into view.
// A change is a checkout measured against its repository's main branch (`base` names it,
// or is HEAD where there is none): its layers, newest first, each the files it changed with
// their counts, not their diffs, which `companions.changeFile` gives one file at a time.
// The layers are the checkout's commits since the merge base with main, then, above
// them, the work not committed yet (staged, unstaged and untracked, not ignored). At most
// `maxChangeLayers` layers and `maxLayerFiles` files are listed, `truncated` says when
// more changed (in `files` too); `root` is the repository's folder, which its paths are from. Or why it
// can't be shown, with the file's size where known.
export const itemContent = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    stamp: z.string().max(128),
    content: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("image"), src: z.string().max(12 * 1024 * 1024) }),
      z.strictObject({
        kind: z.literal("file"),
        path: z.string().max(companionLimits.path),
        firstLine: z.int().min(1),
        lines: z.array(z.string().max(companionLimits.lineLength)).max(companionLimits.lines),
        from: z.int().min(1),
        to: z.int().min(1),
        total: z.int().nonnegative().nullable(),
        truncated: z.boolean(),
        clamped: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("page"),
        url: z.string().max(companionLimits.url),
        shown: z.int().min(1),
        scroll: z.string().max(companionLimits.scroll).optional(),
      }),
      z.strictObject({
        kind: z.literal("changes"),
        root: z.string().max(companionLimits.path),
        base: z.string().max(256),
        layers: z.array(changeLayer).max(maxChangeLayers),
        // The files the change as a whole differs from main by, as `changeRange` lists a
        // range (the layers' own files added up are not that), up to `maxChangedFiles`.
        files: z.array(changedFile).max(maxChangedFiles),
        truncated: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("plan"),
        text: z.string().max(companionLimits.plan),
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
 * - `outside`: the plan's file is in neither its project's folder nor its agent's own
 *   plans folder, so Novadeck does not write it.
 */
export const planUnwritable = z.strictObject({
  reason: z.enum(["gone", "folder", "transcript", "too-large", "not-a-plan", "outside"]),
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
export type ChangeLayer = z.infer<typeof changeLayer>
export type DiffHunk = z.infer<typeof diffHunk>
export type ChangeFileDiff = z.infer<typeof changeFileDiff>
export type ChangeRange = z.infer<typeof changeRange>
export type PlanSaveResult = z.infer<typeof planSaveResult>
