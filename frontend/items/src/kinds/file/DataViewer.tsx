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

// How long the runner cuts a line at (the protocol's `companionLimits.lineLength`, a unit
// less when that would split an emoji): a line that long was likely cut short there.
const longestLine = 4095

/** Whether a file is one the tree reads. */
export const isData = (path: string): boolean => dataFormatOf(path) !== undefined

// The loads already sent to their source: switched back to the preview, they stay.
const sent = new WeakSet<FileContent>()

// Whether only part of the file came: read up to a budget, a window of its lines, or a line
// cut short, as minified JSON's one line.
const isPartial = (file: FileContent): boolean =>
  file.truncated ||
  file.lines.some((line) => line.length >= longestLine) ||
  file.firstLine > 1 ||
  (file.total !== null && file.firstLine + file.lines.length - 1 < file.total)

// What came of the file, as a person reads it: a window of its lines, its start, or its
// lines whole but some cut short.
const partText = (file: FileContent): string => {
  const last = file.firstLine + file.lines.length - 1
  const of = file.total === null ? "" : ` of ${file.total}`
  if (file.firstLine > 1) return `Only lines ${file.firstLine}–${last}${of} were read`
  if (file.truncated || (file.total !== null && last < file.total))
    return `Only the first ${last} lines${of} were read`
  return "Some of its lines are too long and were cut short"
}

const errorText = (format: string, error: DataError): string =>
  `${format} doesn't read at line ${error.line}, column ${error.column}: ${error.message}.`

const formatNames = { json: "JSON", jsonl: "JSONL", yaml: "YAML" } as const

export const DataViewer = ({ id, content: file, toSource }: PreviewProps): React.JSX.Element => {
  const format = dataFormatOf(file.path) ?? "json"
  const partial = isPartial(file)
  const parsed = useMemo(
    () =>
      parseData(file.lines.join("\n"), format, {
        firstLine: file.firstLine,
        longest: longestLine,
      }),
    [file, format],
  )
  // A whole file that doesn't read shows as source, where it stops; one read in part can't
  // be told from one that's broken, so it says so and offers the source.
  const failed = !parsed.ok && !partial ? parsed.error : undefined
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
  const { ref } = useViewerSlot(mountTree, { id, content, label: file.path })
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
            ? `${partText(file)}, so some records may be missing or cut short.`
            : `${partText(file)}, so the tree may be missing some.`}
          {source}
        </p>
      )}
      {parsed.roots.length === 0 && <p className="artifact-status">Nothing in it yet.</p>}
    </>
  )
}
