import type { UiStream } from "../../src/ui-lens.ts"
import { stem } from "../files.ts"
import { actionLiteral, reach, type Site } from "./calls.ts"
import { at, blockEnd, enclosing, indentOf, type Fn, type UiScan } from "./scan.ts"

// The return path: the runner streams the adapter opens, and what their handlers do.

// The function that handles the stream a site opens, and the functions to follow from it.
const handlerOf = (scan: UiScan, site: Site): { handler: Fn | undefined; roots: Fn[] } => {
  const src = scan.sources.get(site.file)!
  const line = src.lines[site.line - 1]!
  const variable = /(\w+)\s*=\s*(?:await\s+)?[\w.]*\.\w+\(/.exec(line)?.[1]
  const consumed = variable
    ? new RegExp(`consume\\(\\s*${variable}\\s*,\\s*(\\w+)`).exec(src.lines.join("\n"))?.[1]
    : undefined
  const named = consumed ? src.fns.find((fn) => fn.name === consumed && !fn.member) : undefined
  if (named) return { handler: named, roots: [named] }
  // A `for await` over the stream: that loop is the handler.
  const loop = src.lines.findIndex(
    (text, i) =>
      i >= site.line - 1 &&
      /for await/.test(text) &&
      (variable ? new RegExp(`\\bof\\s+${variable}\\b`).test(text) : text.includes(".")),
  )
  const loopStart =
    loop === -1
      ? src.lines.findIndex((text, i) => i >= site.line - 1 && /for await/.test(text))
      : loop
  const within = enclosing(src, site.line)[0]
  if (loopStart !== -1 && within && loopStart + 1 <= within.end) {
    const handler: Fn = {
      name: `${within.name} loop`,
      file: site.file,
      start: loopStart + 1,
      end: blockEnd(src.lines, loopStart) + 1,
      indent: indentOf(src.lines[loopStart]!),
      member: false,
    }
    return { handler, roots: [handler] }
  }
  return { handler: undefined, roots: within ? [within] : [] }
}

const streamAt = (scan: UiScan, site: Site, known: Set<string>): UiStream => {
  const { handler, roots } = handlerOf(scan, site)
  const reached = roots.length ? reach(scan, roots, 3) : []
  const text = reached
    .map((each) =>
      (scan.sources.get(each.fn.file)?.lines ?? [])
        .slice(each.fn.start - 1, each.fn.end)
        .join("\n"),
    )
    .join("\n")
  const opens = /\b(?:next|sink)\.open\(/.test(text)
  const dispatches = opens
    ? []
    : [
        ...new Set(
          [...text.matchAll(actionLiteral)]
            .map((match) => match[1]!)
            .filter((type) => known.has(type)),
        ),
      ].toSorted()
  return {
    procedure: site.procedure,
    site: at(site.file, site.line),
    handler: handler ? at(handler.file, handler.start) : null,
    dispatches,
    feeds: dispatches.length
      ? "workspace"
      : opens
        ? "sink.open: the app adds the terminal"
        : /\.update\(/.test(text)
          ? `${stem(site.file)} store`
          : null,
  }
}

// One entry per stream procedure, sorted by procedure; the first call site that resolves a
// handler wins.
export const readStreams = (scan: UiScan, sites: Site[], known: Set<string>): UiStream[] => {
  const streamIds = new Set(
    scan.api.procedures.filter((procedure) => procedure.kind === "stream").map((p) => p.id),
  )
  const byProcedure = new Map<string, UiStream>()
  for (const site of sites.filter((each) => streamIds.has(each.procedure))) {
    const stream = streamAt(scan, site, known)
    const have = byProcedure.get(stream.procedure)
    if (!have || (!have.handler && stream.handler)) byProcedure.set(stream.procedure, stream)
  }
  return [...byProcedure.values()].toSorted((a, b) => a.procedure.localeCompare(b.procedure))
}
