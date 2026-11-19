import type { FilePart, FolderEntry, ItemContent } from "@novadeck/core/items"

import type { SampleArtifact } from "./artifacts"

// A folder the demo lists, as the runner would: a small tree of files kept in memory, which
// the debug panel adds to and writes into, so every state of the folder pane can be reached.
// Each file says how it is listed (`kind`, `size`, `modifiedAt`) and, for one with a picture or
// that opens, what it holds (`read`, its bytes, and `opens`, the item it opens as).

export type DemoFile = {
  readonly name: string
  readonly kind: FolderEntry["kind"]
  size: number
  modifiedAt: number
  readonly secret?: boolean
  readonly link?: boolean
  readonly children?: DemoFile[]
  readonly read?: () => Promise<Uint8Array<ArrayBuffer>>
  // The item this file opens as on a bar, as an agent's show of it would make it.
  readonly opens?: () => SampleArtifact
}

// How the folder is, as the pane lists it: fine, gone, one the runner won't list, or too large
// to list whole (what it holds is then said, not drawn).
export type FolderState = "ready" | "gone" | "secret" | "huge"

export type DemoFolder = {
  readonly top: string
  state: FolderState
  readonly root: DemoFile[]
  // The listing of the folder `within` names, as `companions.content` reads it.
  readonly list: (within: string) => ItemContent
  // Hears the listing of a folder, now and as the folder changes; returns the stop.
  readonly subscribe: (within: string, on: (content: ItemContent) => void) => () => void
  // A file of the folder by its path from the top.
  readonly find: (path: string) => DemoFile | undefined
  // Puts a file in the folder `within` names, or replaces the one of its name, and tells who follows.
  readonly put: (within: string, file: DemoFile) => void
  // Tells who follows that something changed.
  readonly changed: () => void
}

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

const nodeAt = (files: readonly DemoFile[], within: string): readonly DemoFile[] | undefined => {
  let level = files
  for (const name of within.split("/").filter((part) => part !== "")) {
    const next = level.find((file) => file.name === name && file.children)?.children
    if (!next) return undefined
    level = next
  }
  return level
}

const entryOf = (file: DemoFile): FolderEntry => ({
  name: file.name,
  kind: file.kind,
  size: file.kind === "folder" ? 0 : file.size,
  modifiedAt: file.modifiedAt,
  children: file.kind === "folder" && !file.secret ? (file.children?.length ?? 0) : null,
  secret: file.secret === true,
  link: file.link === true,
  stamp: file.read && !file.secret ? `${file.size}:${file.modifiedAt}:${file.name}` : "",
})

export const createFolder = (
  top: string,
  root: DemoFile[],
  state: FolderState = "ready",
): DemoFolder => {
  const followers = new Set<{
    within: string
    on: (content: ItemContent) => void
  }>()
  const folder: DemoFolder = {
    top,
    state,
    root,
    list: (within) => {
      if (folder.state === "gone") return { state: "unavailable", reason: "gone", size: null }
      if (folder.state === "secret") return { state: "unavailable", reason: "secret", size: null }
      const level = nodeAt(root, within)
      if (!level) return { state: "unavailable", reason: "missing", size: null }
      const entries = level.map(entryOf).toSorted((a, b) => a.name.localeCompare(b.name))
      const huge = folder.state === "huge" && within === ""
      const total = huge ? 5000 : entries.length
      return {
        state: "ready",
        stamp: JSON.stringify([within, total, entries]),
        content: {
          kind: "folder",
          path: within === "" ? top : `${top}/${within}`,
          within,
          entries,
          total,
          truncated: huge,
        },
      }
    },
    subscribe: (within, on) => {
      const follower = { within, on }
      followers.add(follower)
      on(folder.list(within))
      return () => followers.delete(follower)
    },
    find: (path) => {
      const names = path.split("/").filter((part) => part !== "")
      const name = names.pop()
      return nodeAt(root, names.join("/"))?.find((file) => file.name === name)
    },
    put: (within, file) => {
      const level = nodeAt(root, within)
      if (!level) return
      const at = (level as DemoFile[]).findIndex((each) => each.name === file.name)
      if (at >= 0) (level as DemoFile[])[at] = file
      else (level as DemoFile[]).push(file)
      folder.changed()
    },
    changed: () => {
      for (const follower of followers) follower.on(folder.list(follower.within))
    },
  }
  return folder
}

// A file's part, as the runner reads one of a folder: while it is as `stamp` says.
export const readFolderPart = async (
  folder: DemoFolder,
  path: string,
  stamp: string,
  offset: number,
  size = 2 * 1024 * 1024,
): Promise<FilePart> => {
  const file = folder.find(path)
  if (!file?.read) return { state: "unavailable", reason: "missing" }
  if (file.secret) return { state: "unavailable", reason: "secret" }
  if (entryOf(file).stamp !== stamp) return { state: "changed" }
  const bytes = await file.read()
  return { state: "part", bytes: bytes.slice(offset, offset + size) }
}

const hour = 3_600_000

// A picture drawn on a 16:10 canvas, as a still of the page an agent rendered.
const still = (name: string, tint: string, label: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 450">` +
      `<rect width="800" height="450" fill="${tint}"/><rect x="40" y="40" width="720" height="60" rx="6" fill="#ffffff" opacity=".7"/><rect x="40" y="130" width="330" height="240" rx="6" fill="#ffffff" opacity=".5"/><rect x="400" y="130" width="360" height="110" rx="6" fill="#ffffff" opacity=".5"/><text x="60" y="78" font-family="Arial, sans-serif" font-size="26" fill="#2d2a24">${label}</text><text x="60" y="420" font-family="Arial, sans-serif" font-size="18" fill="#2d2a24">${name}</text></svg>`,
  )}`

const picture = (name: string, tint: string, label: string, age: number, now: number): DemoFile => {
  const source = still(name, tint, label)
  return {
    name,
    kind: "image",
    size: 38_000,
    modifiedAt: now - age,
    read: async () => encode(decodeURIComponent(source.slice("data:image/svg+xml,".length))),
    opens: () => ({
      item: {
        id: `folder-open-${name}`,
        kind: "image",
        name,
        detail: "38 KB SVG",
        path: `~/render/${name}`,
        url: null,
        lines: null,
        secret: false,
      },
      content: {
        state: "ready",
        stamp: "1",
        content: { kind: "image", src: source },
      },
    }),
  }
}

const textFile = (name: string, lines: readonly string[], age: number, now: number): DemoFile => ({
  name,
  kind: "text",
  size: lines.join("\n").length,
  modifiedAt: now - age,
  opens: () => ({
    item: {
      id: `folder-open-${name}`,
      kind: "file",
      name,
      detail: name,
      path: `~/render/${name}`,
      url: null,
      lines: null,
      secret: false,
    },
    content: {
      state: "ready",
      stamp: "1",
      content: {
        kind: "file",
        path: `~/render/${name}`,
        firstLine: 1,
        lines,
        from: 1,
        to: lines.length,
        total: lines.length,
        truncated: false,
        clamped: false,
      },
    },
  }),
})

// The media a render folder holds, given by whoever makes one: this module imports none of the
// demo's own, so loading it later makes the demo's chunk give it nothing.
export type RenderMedia = {
  readonly clip: () => Promise<Uint8Array<ArrayBuffer>>
  readonly clipSize: number
  readonly report: () => Promise<Uint8Array<ArrayBuffer>>
  readonly reportSize: number
}

// What an agent rendered: stills, a clip, a report, a log, a folder of its own, a secret and a
// link out of the folder. `now` is when the demo started.
export const renderFiles = (now: number, media: RenderMedia): DemoFile[] => [
  picture("checkout-desktop.svg", "#f6f1e7", "Checkout", 4 * 60_000, now),
  picture("checkout-mobile.svg", "#e4e9d6", "Checkout · mobile", 9 * 60_000, now),
  picture("order-summary.svg", "#f1e2d8", "Order summary", 2 * hour, now),
  picture("empty-cart.svg", "#e7e3ee", "Empty cart", 3 * hour, now),
  {
    name: "checkout-walkthrough.webm",
    kind: "video",
    size: media.clipSize,
    modifiedAt: now - 6 * 60_000,
    read: media.clip,
    opens: () => ({
      item: {
        id: "folder-open-walkthrough",
        kind: "video",
        name: "checkout-walkthrough.webm",
        detail: "80 KB WebM",
        path: "~/render/checkout-walkthrough.webm",
        url: null,
        lines: null,
        secret: false,
      },
      content: {
        state: "ready",
        stamp: "1",
        content: {
          kind: "video",
          mime: "video/webm",
          size: media.clipSize,
          shown: 1,
        },
      },
      file: { read: media.clip },
    }),
  },
  {
    name: "quarterly-report.pdf",
    kind: "pdf",
    size: media.reportSize,
    modifiedAt: now - 5 * hour,
    read: media.report,
    opens: () => ({
      item: {
        id: "folder-open-report",
        kind: "pdf",
        name: "quarterly-report.pdf",
        detail: "5 pages, Letter",
        path: "~/render/quarterly-report.pdf",
        url: null,
        lines: null,
        secret: false,
      },
      content: {
        state: "ready",
        stamp: "1",
        content: { kind: "pdf", size: media.reportSize },
      },
      file: { read: media.report },
    }),
  },
  textFile(
    "render.log",
    ["render: start", "render: 4 pages", "render: wrote checkout-desktop.svg", "render: done"],
    7 * 60_000,
    now,
  ),
  {
    name: "old-runs",
    kind: "folder",
    size: 0,
    modifiedAt: now - 26 * hour,
    children: [
      picture("run-1-home.svg", "#e3edf1", "Run 1 · home", 26 * hour, now),
      picture("run-1-cart.svg", "#f3ece0", "Run 1 · cart", 26 * hour, now),
      {
        name: "notes",
        kind: "folder",
        size: 0,
        modifiedAt: now - 30 * hour,
        children: [],
      },
    ],
  },
  {
    name: ".env",
    kind: "other",
    size: 214,
    modifiedAt: now - 2 * hour,
    secret: true,
    read: async () => encode("TOKEN=not-for-the-pane\n"),
  },
  {
    name: ".ssh",
    kind: "folder",
    size: 0,
    modifiedAt: now - 40 * hour,
    secret: true,
    children: [],
  },
  {
    name: "latest",
    kind: "other",
    size: 0,
    modifiedAt: now - hour,
    link: true,
  },
]

// `count` files named by their number, as a folder that holds more than the pane lists whole
// would list its first: they are all there is to see of it.
export const numberedFiles = (count: number, now: number): DemoFile[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `chunk-${String(index + 1).padStart(4, "0")}.js`,
    kind: "text" as const,
    size: 1_000 + index * 37,
    modifiedAt: now - index * 60_000,
  }))

export const folderItem = (
  id: string,
  name: string,
  folder: DemoFolder,
): SampleArtifact & { readonly folder: DemoFolder } => ({
  item: {
    id,
    kind: "folder",
    name,
    detail: folder.top,
    path: folder.top,
    url: null,
    lines: null,
    secret: false,
  },
  content: folder.list(""),
  folder,
})

// What the person opens by its path, as the runner's attach finds it: a file of a folder among
// `samples`, as it opens on a bar; or a folder, one already open or else a stand-in listing, as
// the demo's other files are stand-ins. Undefined for a file that is neither.
export const openedAt = (
  samples: readonly SampleArtifact[],
  path: string,
  now: number,
  media: RenderMedia,
): SampleArtifact | undefined => {
  for (const { folder } of samples) {
    const opens =
      folder && path.startsWith(`${folder.top}/`)
        ? folder.find(path.slice(folder.top.length + 1))?.opens?.()
        : undefined
    if (opens) return opens
  }
  const base = path.split("/").findLast((part) => part !== "") ?? path
  if (base.lastIndexOf(".") > 0) return undefined
  return (
    samples.find((each) => each.folder?.top === path) ??
    folderItem(`folder-${path}`, base, createFolder(path, renderFiles(now, media)))
  )
}
