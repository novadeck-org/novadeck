import { z } from "zod"

import { agentLimits, agentName } from "./agents.js"
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
  // The last lines of a background shell's output a shells item holds, each of at most
  // `lineLength`, and how much of all its shells' outputs it holds at most, in UTF-16 code units.
  shellLines: 400,
  shellsText: 1024 * 1024,
  // How much of a data file (`isDataPath`) is read, from its start, in UTF-8 bytes: whole
  // lines only, none cut to `lineLength`, and as many as fit, as its preview reads the
  // file as a whole. Its text in UTF-16 code units runs no longer.
  data: 2 * 1024 * 1024,
} as const

/**
 * How much of a file one `companions.part` carries, in bytes, for an item the client reads
 * in parts rather than whole. A part travels as base64, so its text runs to `partText`
 * characters.
 */
export const partBytes = 2 * 1024 * 1024
export const partText = Math.ceil(partBytes / 3) * 4

/** A video or a recording the pane plays: the largest one it takes, which it holds whole as it plays. */
export const videoLimits = { bytes: 512 * 1024 * 1024 } as const

/**
 * A PDF the pane previews: the largest one it takes, which it holds whole as it draws it, as
 * pdf.js keeps a whole document in memory however it is read.
 */
export const pdfLimits = { bytes: 128 * 1024 * 1024 } as const

// The files whose preview reads them as a whole, as a tree, a table or a page, by extension.
const dataExtensions = new Set([
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "html",
  "htm",
])

/** Whether a file is read as data: whole, up to `companionLimits.data`, not by its lines. */
export const isDataPath = (path: string): boolean =>
  dataExtensions.has(/\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "")

/** Whether a file is a web page the pane draws, by extension: `.html` or `.htm`. */
export const isHtmlPath = (path: string): boolean => /\.html?$/i.test(path)

/**
 * The files beside a web page that the pane reads for it (`companions.part` with `file`): the
 * most of one, how many, and all told, in bytes. Only what a page draws with
 * (`isPageFile`), and only from the page's own folder or under it.
 */
export const pageLimits = { file: 16 * 1024 * 1024, files: 64, bytes: 32 * 1024 * 1024 } as const

/** Whether a file beside a page is of a type the page draws with: styles, pictures or fonts. */
export const isPageFile = (name: string): boolean =>
  /\.(css|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf)$/i.test(name)

/**
 * A 3D model the pane previews: the most it takes, its file and the files beside it it names
 * (a glTF's buffers and textures, an OBJ's materials and theirs) all told, in bytes, which it
 * holds whole as it draws them; and how many such files it reads.
 */
export const modelLimits = { bytes: 256 * 1024 * 1024, files: 64 } as const

/** The formats of model the pane draws, by the file's extension. */
export const modelFormats = ["glb", "gltf", "stl", "obj", "ply", "3mf"] as const

/**
 * Why a file a model names isn't read with it: `external`, an address of its own (`https:`,
 * `file:`, an absolute path), never read; `outside`, a path out of the model's folder; and as
 * a part's, `missing`, `not-a-file`, `secret` (never shown beside a model), `too-large` (past
 * what's left of `modelLimits.bytes`) or `unreadable`.
 */
export const modelRefusal = z.enum([
  "external",
  "outside",
  "missing",
  "not-a-file",
  "secret",
  "too-large",
  "unreadable",
])

/**
 * A folder the pane lists: at most `entries` of what it holds are listed (`truncated` says
 * when it holds more), each named in at most `name` UTF-16 code units; an image listed with a
 * thumbnail is read through `companions.part`, so it is at most `thumbnail` bytes.
 */
export const folderLimits = { entries: 2000, name: 1024, thumbnail: partBytes } as const

// What agents show and the person attaches beside a terminal: a pointer to a file, a
// page or a plan, never a copy of it, which `companions.content` reads when it loads.
// Each item has one holder, a terminal's bar or a window; `from` is the terminal it was
// shown or attached in, null for a file the person opened in their project window, which
// came from no terminal. `version` counts its shows, `openAsked` says the
// latest one asked to open it, and `secret` marks a file that may hold secrets, which
// opens only when the person picks it. A plan names its agent, its actor's role, and
// whether it is a file or text in the agent's own transcript or rollout. A shells item is
// the background shells the agent in its terminal left running, one per terminal, which the
// runner makes as the first one starts; it points at nothing (`path` and `url` are null).
// A video or an audio recording is a file too, played rather than read, which the runner
// tells by its extension. A folder points at a folder, whose listing it holds, read-only.
const itemHolder = z.union([z.strictObject({ terminalId: id }), z.strictObject({ windowId: id })])
export const companionItem = z.strictObject({
  id,
  sessionId: id,
  holder: itemHolder,
  kind: z.enum([
    "image",
    "video",
    "audio",
    "pdf",
    "model",
    "file",
    "folder",
    "page",
    "plan",
    "changes",
    "shells",
  ]),
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
/** How long a ref a compare names runs at most: a branch, a tag, a hash or an expression of one. */
export const maxCompareRef = 256

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

// One entry of a folder's listing. `kind` is told by the extension; `children` counts what a
// folder holds (null where it is not counted or can't be read); `size` is a file's, in bytes,
// and `modifiedAt` epoch milliseconds. A `secret` entry may hold secrets: it is named, never
// opened, read or counted. A `link` is a symbolic link that leaves the opened folder (or points
// at nothing): it is listed as itself, never entered or read. `stamp` names a file as
// `companions.part` must read it ("" for an entry that is read through no part). `plain: false`
// marks what is no regular file (a pipe, a socket, a device), and `linked: true` a symbolic link
// that stays inside the opened folder, listed as the file or folder it leads to: neither is a
// file of its own to step to. Both are absent otherwise.
export const folderEntry = z.strictObject({
  name: z.string().min(1).max(folderLimits.name),
  kind: z.enum(["folder", "image", "video", "audio", "pdf", "model", "text", "other"]),
  size: z.number().nonnegative(),
  modifiedAt: z.number(),
  children: z.int().nonnegative().nullable(),
  secret: z.boolean(),
  link: z.boolean(),
  linked: z.literal(true).optional(),
  plain: z.literal(false).optional(),
  stamp: z.string().max(128),
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
// them, the work not committed yet (staged, unstaged and untracked, not ignored). A compare
// (`head` set) is two refs an agent named instead: `head`'s commits since its merge base with
// `base`, as `git diff base...head` reads, with no work not committed yet. At most
// `maxChangeLayers` layers and `maxLayerFiles` files are listed, `truncated` says when
// more changed (in `files` too); `root` is the repository's folder, which its paths are from.
// `read` names the files of `files` the person read (`companions.changeRead`) that are still as
// they were then. Shells are the background shells of the agent in the item's terminal, as
// its `activity.shells` lists them, each with the end of its output (`output`): its last
// lines, numbered from `firstLine`, of `total` read; `none` where its harness writes it nowhere
// Novadeck can read (a Codex command run in a terminal of its own, or under the person's own
// `shell_environment_policy`); `unreadable` where its
// file is there and Novadeck can't read it now (no permission, in use, not a regular file);
// `gone` where its file was there and no longer is, as Claude Code's goes with its session.
// A video or a recording (`audio`) is its format and size, which `companions.part` reads in
// parts for the client to play, and its stamp names the file as those parts must be read from; `shown` counts
// the agent's shows, as a page's does, and `at` is the second the latest show starts it at.
// A PDF is its size, its bytes read in parts as a video's are, and drawn by the client.
// A 3D model is its format and size, read in parts as a PDF is, and the files beside it it
// names, by name as the model writes it: each it reads with its size and stamp, which
// `companions.part` reads by that name, and each it doesn't with why.
// A folder is its listing, read again whenever it changes: `within` is the path of the folder
// listed from the one the item points at (its top; "" for the top itself, "/" between names),
// `path` its own, `entries` at most `folderLimits.entries` of what it holds, of `total` (the
// rest is `truncated`).
// Or why it can't be shown, with the file's size where known.
export const itemContent = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    stamp: z.string().max(128),
    content: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("image"), src: z.string().max(12 * 1024 * 1024) }),
      z
        .strictObject({
          kind: z.literal("file"),
          path: z.string().max(companionLimits.path),
          firstLine: z.int().min(1),
          // A data file's lines run as long as its text; others' are held to the limits below.
          lines: z.array(z.string().max(companionLimits.data)).max(companionLimits.data + 1),
          from: z.int().min(1),
          to: z.int().min(1),
          total: z.int().nonnegative().nullable(),
          truncated: z.boolean(),
          clamped: z.boolean(),
        })
        .check((context) => {
          const { path, lines } = context.value
          const issue = (message: string): void => {
            context.issues.push({ code: "custom", input: context.value, path: ["lines"], message })
          }
          if (isDataPath(path)) {
            const size = lines.reduce((sum, line) => sum + line.length, 0)
            if (size > companionLimits.data) issue("A data file's text runs past its limit")
            return
          }
          if (lines.length > companionLimits.lines) issue("Too many lines")
          if (lines.some((line) => line.length > companionLimits.lineLength))
            issue("A line runs past its limit")
        }),
      z.strictObject({
        kind: z.literal("page"),
        url: z.string().max(companionLimits.url),
        shown: z.int().min(1),
        scroll: z.string().max(companionLimits.scroll).optional(),
      }),
      z.strictObject({
        kind: z.literal("folder"),
        path: z.string().max(companionLimits.path),
        within: z.string().max(companionLimits.path),
        entries: z.array(folderEntry).max(folderLimits.entries),
        total: z.int().nonnegative(),
        truncated: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("changes"),
        root: z.string().max(companionLimits.path),
        base: z.string().max(256),
        head: z.string().max(maxCompareRef).optional(),
        // For a compare that reads a remote-tracking ref: when the repository's origin was last
        // fetched (epoch milliseconds; absent if never) and why its last fetch failed, if it did.
        origin: z
          .strictObject({
            fetchedAt: z.number().optional(),
            failed: z.string().max(300).optional(),
          })
          .optional(),
        layers: z.array(changeLayer).max(maxChangeLayers),
        // The files the change as a whole differs from main by, as `changeRange` lists a
        // range (the layers' own files added up are not that), up to `maxChangedFiles`.
        files: z.array(changedFile).max(maxChangedFiles),
        read: z.array(z.string().max(companionLimits.path)).max(maxChangedFiles),
        truncated: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("shells"),
        agent: agentName,
        shells: z
          .array(
            z.strictObject({
              id: z.string().min(1).max(agentLimits.name),
              command: z.string().max(agentLimits.command),
              since: z.number(),
              exit: z
                .strictObject({ at: z.number(), code: z.number().int().nullable() })
                .nullable(),
              output: z.discriminatedUnion("state", [
                z.strictObject({
                  state: z.literal("ready"),
                  firstLine: z.int().min(1),
                  lines: z
                    .array(z.string().max(companionLimits.lineLength))
                    .max(companionLimits.shellLines),
                  total: z.int().nonnegative(),
                }),
                z.strictObject({ state: z.literal("none") }),
                z.strictObject({ state: z.literal("unreadable") }),
                z.strictObject({ state: z.literal("gone") }),
              ]),
            }),
          )
          .max(agentLimits.shells),
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
      z.strictObject({
        kind: z.literal("video"),
        mime: z.string().max(64),
        size: z.int().nonnegative().max(videoLimits.bytes),
        shown: z.int().min(1),
        at: z.number().nonnegative().optional(),
      }),
      z.strictObject({
        kind: z.literal("audio"),
        mime: z.string().max(64),
        size: z.int().nonnegative().max(videoLimits.bytes),
        shown: z.int().min(1),
        at: z.number().nonnegative().optional(),
      }),
      z.strictObject({
        kind: z.literal("pdf"),
        size: z.int().nonnegative().max(pdfLimits.bytes),
      }),
      z.strictObject({
        kind: z.literal("model"),
        format: z.enum(modelFormats),
        size: z.int().nonnegative().max(modelLimits.bytes),
        files: z
          .array(
            z.strictObject({
              name: z.string().max(companionLimits.path),
              size: z.int().nonnegative().max(modelLimits.bytes),
              stamp: z.string().max(128),
            }),
          )
          .max(modelLimits.files),
        refused: z
          .array(
            z.strictObject({ name: z.string().max(companionLimits.path), reason: modelRefusal }),
          )
          .max(modelLimits.files),
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

// `companions.part`: the part of an item's file from the offset asked for, as base64, up to
// `partBytes` bytes (fewer at the file's end); `changed` when the file is no longer
// as the stamp asked with names it, so the client reads it again from its new content; or
// why it can't be read now.
export const filePart = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("part"), data: z.string().max(partText) }),
  z.strictObject({ state: z.literal("changed") }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["missing", "unreadable", "not-a-file", "too-large", "secret"]),
  }),
])

// `companions.folders`: how many folders it names at most, how many of a folder's entries it
// reads to find them, and how many it counts in each before it says "that many or more".
export const folderMatchLimits = { matches: 20, scanned: 5000, counted: 1000 } as const

// `companions.folders`: the folders under the typed path's parent whose names start as its last
// part does. `path` is written as the person typed the parent (a leading `~`, or relative to the
// terminal's directory) and ends in the folder's own name, so it completes the typed text;
// `real` is its absolute path through links, as a folder item showing it holds it, so lists that
// write a folder differently tell it is the same one; `count` is how many entries the folder
// holds, up to `folderMatchLimits.counted`; `open` says a folder item already shows it.
export const folderMatch = z.strictObject({
  path: z.string().min(1).max(companionLimits.path),
  real: z.string().min(1).max(companionLimits.path),
  count: z.int().min(0).max(folderMatchLimits.counted),
  open: z.boolean(),
})

// How many folders `companions.wroteTo` names at most.
export const maxWroteFolders = 8

// `companions.wroteTo`: a folder outside the project that a session's agent wrote a file in, and
// when (milliseconds since the epoch), with the terminal's handle and the agent's harness.
// `path` is absolute, or led by `~` for one in the person's home; `real` is its absolute path
// through links, as `folderMatch`'s is.
export const wroteFolder = z.strictObject({
  path: z.string().min(1).max(companionLimits.path),
  real: z.string().min(1).max(companionLimits.path),
  handle,
  agent: agentName,
  at: z.number(),
})

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
export type FolderEntry = z.infer<typeof folderEntry>
export type PageTrouble = z.infer<typeof pageTrouble>
export type PageLook = z.infer<typeof pageLook>
export type PageLookAnswer = z.infer<typeof pageLookAnswer>
export type ChangedFile = z.infer<typeof changedFile>
export type ChangeLayer = z.infer<typeof changeLayer>
export type DiffHunk = z.infer<typeof diffHunk>
export type ChangeFileDiff = z.infer<typeof changeFileDiff>
export type ChangeRange = z.infer<typeof changeRange>
export type PlanSaveResult = z.infer<typeof planSaveResult>
export type FilePart = z.infer<typeof filePart>
export type FolderMatch = z.infer<typeof folderMatch>
export type WroteFolder = z.infer<typeof wroteFolder>
