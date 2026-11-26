import type { FileContent } from "@novadeck/core/items"
import {
  dataFormatOf,
  mountTree,
  parseData,
  type DataError,
  type TreeContent,
} from "@novadeck/viewers/tree"
import { useEffect, useMemo } from "react"

import { useViewerSlot } from "../../ViewerSlot"
import type { PreviewProps } from "./previews"

// A data file the agent showed (JSON, JSONL or YAML), as a tree, in the tree viewer. What
// doesn't read goes to its source at the line it stops, once per load: switched back, it
// says where it stops. A file read only in part says so.

// The loads already sent to their source: switched back to the preview, they stay.
const sent = new WeakSet<FileContent>()
// The loads already brought to the lines their agent pointed at: shown again, they open
// where they were left.
const pointed = new WeakSet<FileContent>()

// Whether only part of the file came: its start, up to the runner's budget for data files
// (2 MiB of whole lines), or, from a runner before that, a window of its lines.
const isPartial = (file: FileContent): boolean =>
  file.truncated ||
  file.firstLine > 1 ||
  (file.total !== null && file.firstLine + file.lines.length - 1 < file.total)

// What came of the file, as a person reads it: its start, or a window of its lines.
const partText = (file: FileContent): string => {
  const last = file.firstLine + file.lines.length - 1
  const of = file.total === null ? "" : ` of ${file.total}`
  if (file.truncated) return "Only its start was read, as it's longer than Novadeck reads at once"
  if (file.firstLine > 1) return `Only lines ${file.firstLine}–${last}${of} were read`
  return `Only the first ${last} lines${of} were read`
}

// Whether a file read from its start stops reading before the last line that came, which
// may be the only one cut short: broken, not cut.
const brokenWithin = (file: FileContent, error: DataError): boolean =>
  file.firstLine === 1 && error.line < file.firstLine + file.lines.length - 1

const errorText = (format: string, error: DataError): string =>
  `${format} doesn't read at line ${error.line}, column ${error.column}: ${error.message}.`

const formatNames = { json: "JSON", jsonl: "JSONL", yaml: "YAML" } as const

export const DataViewer = ({ id, content: file, toSource }: PreviewProps): React.JSX.Element => {
  const format = dataFormatOf(file.path) ?? "json"
  const partial = isPartial(file)
  const parsed = useMemo(
    () => parseData(file.lines.join("\n"), format, { firstLine: file.firstLine }),
    [file, format],
  )
  // A file that doesn't read shows as source, where it stops: a whole one, or one read from
  // its start that stops before the lines that came end. Else it may only be cut short, so
  // it says so and offers the source.
  const failed =
    !parsed.ok && (!partial || brokenWithin(file, parsed.error)) ? parsed.error : undefined
  const note = failed && errorText(formatNames[format], failed)
  useEffect(() => {
    if (!failed || !note || sent.has(file)) return
    sent.add(file)
    toSource({ note, line: failed.line })
  }, [failed, note, file, toSource])
  const content = useMemo(
    (): TreeContent => ({
      roots: parsed.ok ? parsed.roots : [],
      path: file.path,
      // A JSONL file's records start closed, one row each.
      ...(format === "jsonl" ? { opening: { roots: false } } : {}),
    }),
    [parsed, file.path, format],
  )
  const { ref, viewer } = useViewerSlot(mountTree, { id, content, label: file.path })
  // Lines pointed at past the first, as a record of a JSONL file or a YAML document:
  // the row that holds them, once per load.
  useEffect(() => {
    if (!viewer || pointed.has(file) || file.from <= file.firstLine) return
    pointed.add(file)
    viewer.jumpTo({ line: file.from })
  }, [viewer, file])
  const source = (
    <button type="button" className="artifact-open" onClick={() => toSource()}>
      Show source
    </button>
  )
  if (failed)
    return (
      <div className="artifact-unavailable" data-reason="unreadable">
        <p>{note}</p>
        <div className="artifact-unavailable-actions">
          <button
            type="button"
            className="artifact-open"
            onClick={() => toSource({ note: note || "", line: failed.line })}
          >
            Show source at line {failed.line}
          </button>
        </div>
      </div>
    )
  if (!parsed.ok)
    return (
      <div className="artifact-unavailable" data-reason="partial">
        <p>
          {partText(file)}, so the {formatNames[format]} can't be read as a whole.
        </p>
        <div className="artifact-unavailable-actions">{source}</div>
      </div>
    )
  return (
    <>
      <div ref={ref} className="artifact-tree" />
      {partial && (
        <p className="artifact-cut artifact-tree-cut">
          {format === "jsonl"
            ? `${partText(file)}, so some records may be missing.`
            : `${partText(file)}, so the tree may be missing some.`}
          {source}
        </p>
      )}
      {parsed.roots.length === 0 && <p className="artifact-status">Nothing in it yet.</p>}
    </>
  )
}
