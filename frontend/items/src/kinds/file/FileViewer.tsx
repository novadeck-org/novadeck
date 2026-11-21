import type { Item, FileContent } from "@novadeck/core/items"
import { mountCode, type CodeContent } from "@novadeck/viewers/code"
import { CodeXml } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { PaneTools, type PaneTool } from "../../pane-row"
import { readBeside } from "../../parts/beside"
import { useViewerSlot } from "../../ViewerSlot"
import { previewFor, type FilePreview, type ReadBeside, type ToSource } from "./previews"
import { PreviewToolsSetter } from "./previews/tools"
import { useFileView } from "./view-choice"

// A text file, as plain text at once, then highlighted when its language is one Novadeck
// knows, in the code viewer. Where its viewer was, by item, is kept, so a file shown again
// opens where it was.

// How many lines the code viewer draws at most, as it draws every one: a data file comes
// whole, up to 2 MiB, so its source shows this many around the line it points at.
const drawnLines = 2000
// Lines shown before the one pointed at.
const drawnBefore = 40

// The lines of `file` to draw, around `line`: all of them, unless there are too many.
const drawnOf = (
  file: FileContent,
  line: number,
): { readonly firstLine: number; readonly lines: readonly string[]; readonly cut: boolean } => {
  if (file.lines.length <= drawnLines)
    return { firstLine: file.firstLine, lines: file.lines, cut: false }
  const start = Math.min(
    Math.max(0, line - file.firstLine - drawnBefore),
    file.lines.length - drawnLines,
  )
  return {
    firstLine: file.firstLine + start,
    lines: file.lines.slice(start, start + drawnLines),
    cut: true,
  }
}

const CodeViewer = ({
  id,
  content: artifact,
  at,
}: Pick<ArtifactBodyProps<"file">, "content"> & {
  id: Item["id"]
  // A line to point at instead of the agent's, as where a preview's file stops reading.
  at?: number
}): React.JSX.Element => {
  const drawn = useMemo(() => drawnOf(artifact, at ?? artifact.from), [artifact, at])
  const content = useMemo(
    (): CodeContent => ({
      lines: drawn.lines,
      firstLine: drawn.firstLine,
      path: artifact.path,
      // The lines the agent pointed at.
      emphasis: at === undefined ? { from: artifact.from, to: artifact.to } : { from: at, to: at },
    }),
    [artifact, at, drawn],
  )
  const { ref: code } = useViewerSlot(mountCode, {
    id,
    content,
    label: artifact.path,
  })
  return (
    <>
      <div ref={code} className="artifact-code" />
      {(artifact.clamped || artifact.truncated || drawn.cut) && (
        <p className="artifact-cut">
          {[
            artifact.clamped && `The file ends at line ${artifact.to}.`,
            artifact.truncated && "It's long, so only its start is shown.",
            drawn.cut &&
              `Lines ${drawn.firstLine}–${drawn.firstLine + drawn.lines.length - 1} of the ${artifact.lines.length} read are shown here.`,
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </>
  )
}

// The key that switches a file between its preview and its source, from anywhere in it
// (the row's switch among it): ⌘⇧V, or Ctrl+Shift+V, as editors open a Markdown preview.
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
export const switchKey = {
  aria: mac ? "Meta+Shift+V" : "Control+Shift+V",
  text: mac ? "⌘⇧V" : "Ctrl+Shift+V",
}

// By the letter it types, so it's the V the tooltip names on Latin layouts (Dvorak, AZERTY);
// where the layout types another script (Cyrillic, Greek, Hebrew), by where V sits.
const isV = (event: KeyboardEvent): boolean =>
  /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "v" : event.code === "KeyV"

const isSwitchKey = (event: KeyboardEvent): boolean =>
  isV(event) &&
  event.shiftKey &&
  !event.altKey &&
  (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)

// The loads of files their preview sent to their source, and why: not the person's choice,
// so it isn't kept as one, and the file's next load, as once its agent fixes it, previews
// again; by load, so the pane built again, as across views, shows it the same.
const sentToSource = new WeakMap<FileContent, { readonly note: string; readonly line?: number }>()

// A file of a type with a preview: the preview first, or its source as the person last
// switched it for this item and file, with the switch in the pane's row after the preview's
// own tools. The file takes focus from a click anywhere in it, so its key works from there,
// and keeps it as it switches, so the key switches it back: a region named for the file and
// what it shows now, ringed when the keyboard moved focus there. A key held down switches once.
const PreviewedFile = ({
  item,
  content,
  preview,
  beside,
}: {
  item: Item
  content: FileContent
  preview: FilePreview
  beside: ReadBeside | undefined
}): React.JSX.Element => {
  const [view, choose] = useFileView(item.id, content.path)
  const [tools, setTools] = useState<readonly PaneTool[]>([])
  const holder = useRef<HTMLDivElement>(null)
  const setPreviewTools = useCallback((next: readonly PaneTool[]) => setTools(next), [])
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const note = sentToSource.get(content) ?? null
  const source = view === "source" || note !== null
  const toggle = (): void => {
    sentToSource.delete(content)
    choose(source ? "preview" : "source")
  }
  const toSource = useCallback<ToSource>(
    (why) => {
      if (!why) return choose("source")
      sentToSource.set(content, why)
      redraw()
    },
    [choose, content],
  )
  const Preview = preview.View
  return (
    <div
      ref={holder}
      className="artifact-file"
      data-file-preview={preview.name}
      data-view={source ? "source" : "preview"}
      tabIndex={-1}
      role="region"
      aria-label={`${item.name}, ${source ? "source" : "preview"}`}
      // The row's switch is drawn in the row, but its keys come here as from inside.
      onKeyDown={(event) => {
        if (!isSwitchKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        // What has focus may be the view going away.
        if (holder.current?.contains(document.activeElement))
          holder.current.focus({ preventScroll: true })
        toggle()
      }}
    >
      <PaneTools
        tools={[
          ...(source ? [] : tools),
          {
            key: "source",
            icon: CodeXml,
            label: "Show source",
            tip: `${source ? "Show the preview" : "Show the source"} · ${switchKey.text}`,
            pressed: source,
            keys: switchKey.aria,
            onClick: toggle,
          },
        ]}
      />
      {source ? (
        <>
          {note && <p className="artifact-cut artifact-source-note">{note.note}</p>}
          <CodeViewer
            id={item.id}
            content={content}
            {...(note?.line === undefined ? {} : { at: note.line })}
          />
        </>
      ) : (
        <PreviewToolsSetter value={setPreviewTools}>
          <Preview
            id={item.id}
            name={item.name}
            content={content}
            toSource={toSource}
            beside={beside}
          />
        </PreviewToolsSetter>
      )}
    </div>
  )
}

// The files beside the one shown, as its backend reads them (`part` by `file`): never the ones
// that may hold secrets, whatever the person revealed. Where the shown file is read for is kept
// as it is when a read asks.
const useBeside = (
  id: Item["id"],
  part: ArtifactBodyProps<"file">["itemStore"]["part"],
  target: ArtifactBodyProps<"file">["target"],
): ReadBeside | undefined => {
  const where = useRef(target)
  useEffect(() => {
    where.current = target
  })
  return useMemo(
    () =>
      part &&
      ((name, signal) =>
        readBeside({
          read: (offset) =>
            part(where.current, id, { stamp: "", offset, reveal: undefined, file: name }),
          signal,
        })),
    [id, part],
  )
}

// A file: one with a preview shows it, with a switch to its source; anything else as code.
export const FileViewer = ({
  item,
  content,
  itemStore,
  target,
}: ArtifactBodyProps<"file">): React.JSX.Element => {
  const preview = previewFor(content.path)
  const beside = useBeside(item.id, itemStore.part, target)
  return preview ? (
    <PreviewedFile item={item} content={content} preview={preview} beside={beside} />
  ) : (
    <CodeViewer id={item.id} content={content} />
  )
}

// The lines the agent pointed at, from the first one on.
// No more than a miniature shows, as a data file comes whole: its lines up to 2 MiB.
const thumbLines = 40
const thumbLength = 200
const pointedLines = (file: FileContent): readonly string[] =>
  file.lines
    .slice(
      file.from - file.firstLine,
      Math.min(file.to - file.firstLine + 1, file.from - file.firstLine + thumbLines),
    )
    .map((line) => line.slice(0, thumbLength))

// A file in miniature: its preview's, where it has one, as a Markdown file's title over its
// sections; else the lines the agent pointed at.
export const FileThumb = ({ content }: { content: FileContent }): React.JSX.Element => {
  const Thumb = previewFor(content.path)?.Thumb
  return Thumb ? (
    <Thumb content={content} />
  ) : (
    <code className="peek-code">{pointedLines(content).join("\n")}</code>
  )
}
