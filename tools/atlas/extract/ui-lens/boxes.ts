import type { BoxItem, UiAction, UiProcedure, UiStream, WiringBox } from "../../src/ui-lens.ts"
import type { Site } from "./calls.ts"
import { at, core, isBackend, isComment, portFile, stateFile, ui, type UiScan } from "./scan.ts"

// The boxes of the wiring diagram: what each layer between a component and the runner holds.

const uiStoreFile = `${ui}/app/ui-store.ts`
const workspaceStoreFile = `${core}/store.ts`

const item = (
  scan: UiScan,
  label: string,
  file: string | null,
  line: number | null,
  note?: string,
): BoxItem => ({
  label,
  area: file ? scan.area(file) : null,
  anchor: file ? at(file, line ?? 1) : null,
  ...(note === undefined ? {} : { note }),
})

type Hits = Map<string, { count: number; first: number }>

// Boxes list one item per file, the busiest first.
const perFile = (scan: UiScan, hits: Hits, noun: string): BoxItem[] =>
  [...hits.entries()]
    .toSorted((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([file, hit]) =>
      item(
        scan,
        file.slice(ui.length + 1),
        file,
        hit.first,
        `${hit.count} ${noun}${hit.count === 1 ? "" : "s"}`,
      ),
    )

// The matches of `pattern` in the files `include` admits, per file and in all.
const countMatches = (
  scan: UiScan,
  pattern: RegExp,
  include: (file: string) => boolean,
): { hits: Hits; total: number } => {
  const hits: Hits = new Map()
  let total = 0
  for (const src of scan.allSources) {
    if (!include(src.file)) continue
    src.lines.forEach((line, i) => {
      if (isComment(line) || /^\s*export (const|function)/.test(line)) return
      const count = [...line.matchAll(pattern)].length
      if (!count) return
      total += count
      const have = hits.get(src.file)
      hits.set(src.file, { count: (have?.count ?? 0) + count, first: have?.first ?? i + 1 })
    })
  }
  return { hits, total }
}

// The lines of the block that opens at `start` in a file's lines, until its closing `}`.
const blockLines = (lines: string[], start: number): [line: string, number: number][] => {
  const block: [string, number][] = []
  for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("}"); i++)
    block.push([lines[i]!, i])
  return block
}

const uiSlices = (scan: UiScan): BoxItem[] => {
  const lines = scan.source(uiStoreFile)?.lines ?? []
  const start = lines.findIndex((l) => l.startsWith("export type UiState"))
  if (start === -1) scan.anchors.report("ui store", uiStoreFile, 'expected "export type UiState"')
  const slices: BoxItem[] = []
  for (const [line, i] of blockLines(lines, start)) {
    const match = /^ {2}readonly (\w+):/.exec(line)
    if (match) slices.push(item(scan, match[1]!, uiStoreFile, i + 1))
  }
  if (start !== -1 && slices.length === 0)
    scan.anchors.report("ui store", uiStoreFile, "found 0 slices in `UiState`")
  return slices
}

const portMembers = (scan: UiScan): BoxItem[] => {
  const lines = scan.source(portFile)?.lines ?? []
  const start = lines.findIndex((l) => l.startsWith("export type BackendFields = {"))
  if (start === -1)
    scan.anchors.report("ui backend port", portFile, 'expected "export type BackendFields = {"')
  const members: BoxItem[] = []
  for (const [line, i] of blockLines(lines, start)) {
    const match = /^ {2}readonly (\w+)\??[:=]/.exec(line)
    if (match)
      members.push(
        item(
          scan,
          match[1]!,
          portFile,
          i + 1,
          match[1] === "commit" ? "called inside every commit" : undefined,
        ),
      )
  }
  if (start !== -1 && members.length === 0)
    scan.anchors.report("ui backend port", portFile, "found 0 members in `BackendFields`")
  return members.toSorted((a, b) => Number(b.label === "commit") - Number(a.label === "commit"))
}

// The action types the adapter may dispatch back: the quoted types in `BackendAction`.
const sinkTypes = (scan: UiScan): BoxItem[] => {
  const lines = scan.source(portFile)?.lines ?? []
  const types: BoxItem[] = []
  const start = lines.findIndex((l) => l.startsWith("export type BackendAction"))
  if (start === -1)
    scan.anchors.report("ui backend port", portFile, 'expected "export type BackendAction"')
  for (let i = start + 1; i < lines.length; i++) {
    if (start === -1) break
    if (/^(?:>|\}|export )/.test(lines[i]!)) break
    for (const match of lines[i]!.matchAll(/"([a-z]+\/[a-z-]+)"/g))
      types.push(item(scan, match[1]!, portFile, i + 1))
  }
  if (start !== -1 && types.length === 0)
    scan.anchors.report("ui backend port", portFile, "found 0 action types in `BackendAction`")
  return types
}

export const wiringBoxes = (
  scan: UiScan,
  parts: {
    actions: UiAction[]
    procedures: UiProcedure[]
    sites: Site[]
    streams: UiStream[]
  },
): WiringBox[] => {
  const { actions, procedures, sites, streams } = parts
  const readers = countMatches(
    scan,
    /\b(?:useWorkspaceState|useUiState|useStoreSelector|useSyncExternalStore)\(/g,
    (f) => f !== workspaceStoreFile,
  )
  const writers = countMatches(
    scan,
    /\b(?:workspace|store)\.(?:dispatch|transact)\(/g,
    (f) => !isBackend(f) && f !== workspaceStoreFile,
  )
  const uiWrites = countMatches(scan, /\b(?:ui\.update|updateShell)\(/g, (f) => !isBackend(f))
  const featureStores = countMatches(
    scan,
    /\bcreateStore\s*(?:<[^(]*>)?\(/g,
    (f) => f !== workspaceStoreFile,
  )
  const slices = uiSlices(scan)
  const members = portMembers(scan)
  const sink = sinkTypes(scan)

  const prefixes = new Map<string, UiAction[]>()
  for (const action of actions)
    prefixes.set(action.prefix, [...(prefixes.get(action.prefix) ?? []), action])

  const adapterHits: Hits = new Map()
  for (const site of sites) {
    const have = adapterHits.get(site.file)
    adapterHits.set(site.file, { count: (have?.count ?? 0) + 1, first: have?.first ?? site.line })
  }

  const calledIds = new Set(procedures.map((procedure) => procedure.id))
  const byNs = new Map<string, { served: number; called: number }>()
  for (const procedure of scan.api.procedures) {
    const have = byNs.get(procedure.namespace) ?? { served: 0, called: 0 }
    byNs.set(procedure.namespace, {
      served: have.served + 1,
      called: have.called + Number(calledIds.has(procedure.id)),
    })
  }
  const calls = procedures.filter((procedure) => procedure.kind === "call")
  const withHandler = streams.filter((stream) => stream.handler)

  return [
    {
      id: "components",
      title: "Components & hooks",
      count: readers.total,
      unit: "selectors",
      items: perFile(scan, readers.hits, "read"),
    },
    {
      id: "commands",
      title: "Commands & controller",
      count: writers.total,
      unit: "dispatch sites",
      items: perFile(scan, writers.hits, "site"),
    },
    {
      id: "workspace",
      title: "Workspace store",
      count: actions.length,
      unit: "action types",
      items: [
        item(
          scan,
          "createWorkspaceStore",
          workspaceStoreFile,
          scan.anchors.find(workspaceStoreFile, "export const createWorkspaceStore"),
        ),
        ...[...prefixes.entries()].map(([prefix, list]) =>
          item(
            scan,
            `${prefix}/`,
            stateFile,
            list[0]!.reducer?.line ?? 1,
            `${list.length} action${list.length === 1 ? "" : "s"}`,
          ),
        ),
      ],
    },
    {
      id: "ui",
      title: "UI store",
      count: slices.length,
      unit: "slices",
      items: [
        item(
          scan,
          "update() sites",
          uiStoreFile,
          1,
          `${uiWrites.total} in ${uiWrites.hits.size} files`,
        ),
        ...slices,
      ],
    },
    {
      id: "feature",
      title: "Feature stores",
      count: featureStores.total,
      unit: "createStore",
      items: perFile(scan, featureStores.hits, "store"),
    },
    {
      id: "port",
      title: "Backend port",
      count: members.length,
      unit: "members",
      items: members,
    },
    {
      id: "adapter",
      title: "Runner adapter",
      count: adapterHits.size,
      unit: "files call it",
      items: perFile(scan, adapterHits, "call"),
    },
    {
      id: "procedures",
      title: "oRPC procedures",
      count: calls.length,
      unit: "calls",
      items: calls.map((procedure) =>
        item(
          scan,
          procedure.id,
          procedure.sites[0]!.file,
          procedure.sites[0]!.line,
          procedure.fromCommit ? "from a commit" : "other",
        ),
      ),
    },
    {
      id: "runner",
      title: "Runner",
      count: scan.api.procedures.length,
      unit: "procedures served",
      items: [...byNs.entries()].map(([ns, counts]) =>
        item(
          scan,
          ns,
          "contract/protocol/src/contract.ts",
          1,
          `${counts.called} of ${counts.served} called by the UI`,
        ),
      ),
    },
    {
      id: "streams",
      title: "Runner streams",
      count: streams.length,
      unit: "streams",
      items: streams.map((stream) =>
        item(
          scan,
          stream.procedure,
          stream.site.file,
          stream.site.line,
          stream.dispatches.length
            ? `${stream.dispatches.length} actions`
            : (stream.feeds ?? "no store write found"),
        ),
      ),
    },
    {
      id: "consumers",
      title: "Stream handlers",
      count: withHandler.length,
      unit: "handlers",
      items: withHandler.map((stream) =>
        item(scan, stream.procedure, stream.handler!.file, stream.handler!.line),
      ),
    },
    {
      id: "sink",
      title: "Sink dispatch",
      count: sink.length,
      unit: "action types",
      items: sink,
    },
  ]
}
