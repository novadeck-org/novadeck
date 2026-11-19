import type { UnavailableReason } from "@novadeck/core/items"
import { Progress } from "@novadeck/toolkit/Progress"
import { createKept } from "@novadeck/viewers"
import { mountPdf, type PdfTrouble } from "@novadeck/viewers/pdf"
import { useEffect, useMemo, useRef, useState } from "react"

import { Unavailable, type ArtifactBodyProps } from "../../ArtifactViewer"
import { raisePaneAction } from "../../pane-actions"
import { usePaneNote } from "../../pane-row"
import { loadParts } from "../../parts/load"
import { useRevealed } from "../../store/use-item-store"
import { useViewerSlot } from "../../ViewerSlot"
import { bytesText, loadingText } from "../video/format"
import { pdfAssets, pdfFrame } from "./assets"

// The PDFs read for panes, by item and stamp, up to 256 MB in all: a pane that goes and comes
// back, as a view switch, draws its PDF again without reading it.
const kept = createKept<Blob>(256 * 1024 * 1024, (blob) => blob.size)

// Where a PDF's bytes stand: in, with the last file's kept while a newer one's are read, so
// it stays in view until the new one is ready; how far a read has got; or why there's nothing.
type Source = {
  readonly bytes: Blob | undefined
  readonly loaded: number | null
  readonly problem: UnavailableReason | "failed" | "here" | null
}

type Read = {
  readonly key: string
  readonly bytes: Blob | undefined
  readonly problem: Source["problem"]
}

// Reads the PDF's bytes while it shows, for the stamp it is at; each new stamp reads it afresh.
const useSource = ({
  item,
  content,
  stamp,
  itemStore,
  target,
}: ArtifactBodyProps<"pdf">): Source => {
  const { part: readPart } = itemStore
  const { size } = content
  // The person's yes to a file that may hold secrets, which its parts are read with.
  const reveal = useRevealed(itemStore, item)
  const id = item.id
  const key = `${id}:${stamp}`
  // A pane that comes back starts from the bytes read before, which it holds however long
  // they stay kept, and keeps in view while a rewritten file is read.
  const [read, setRead] = useState<Read | undefined>(() => {
    const bytes = kept.get(key)
    return bytes ? { key, bytes, problem: null } : undefined
  })
  const [progress, setProgress] = useState<{ key: string; loaded: number }>()
  // Where it's read for, which a read in progress takes as it is when it asks.
  const where = useRef(target)
  useEffect(() => {
    where.current = target
  })
  useEffect(() => {
    if (!readPart || kept.get(key)) return
    const stop = new AbortController()
    void loadParts({
      read: async (offset) => readPart(where.current, id, { stamp, offset, reveal }),
      size,
      mime: "application/pdf",
      signal: stop.signal,
      progress: (loaded) => setProgress({ key, loaded }),
    }).then((result) => {
      if (stop.signal.aborted || result.state === "stopped") return
      // A file rewritten while it was read: the content that follows reads it again.
      if (result.state === "changed") return setProgress({ key, loaded: 0 })
      if (result.state === "ready") {
        kept.keep(key, result.blob)
        return setRead({ key, bytes: result.blob, problem: null })
      }
      setRead({
        key,
        bytes: undefined,
        problem: result.state === "failed" ? "failed" : result.reason,
      })
    })
    return () => stop.abort()
  }, [id, key, stamp, size, reveal, readPart])
  if (!readPart) return { bytes: undefined, loaded: null, problem: "here" }
  if (read?.key === key) return { bytes: read.bytes, loaded: null, problem: read.problem }
  // Kept from another pane of it since this one mounted.
  const bytes = kept.get(key)
  if (bytes) return { bytes, loaded: null, problem: null }
  return { bytes: read?.bytes, loaded: progress?.key === key ? progress.loaded : 0, problem: null }
}

// The PDF itself, in the PDF viewer, which keeps its page and zoom by item and file: the item
// pointed at another file opens it at its first page, not at the last one's.
// Its frame's keys for the pane (Escape, Ctrl+PageDown and Ctrl+PageUp) come out as the pane's
// actions, raised from here for the pane to carry out.
const Pages = ({ id, name, bytes }: { id: string; name: string; bytes: Blob }) => {
  const content = useMemo(() => ({ bytes }), [bytes])
  const [trouble, setTrouble] = useState<PdfTrouble | null>(null)
  const element = useRef<HTMLDivElement | null>(null)
  const frame = useMemo(() => pdfFrame(), [])
  const { ref } = useViewerSlot(mountPdf, {
    id,
    content,
    label: name,
    frame,
    assets: pdfAssets,
    onTrouble: setTrouble,
    onAction: (action) => element.current && raisePaneAction(element.current, action),
  })
  return (
    <div
      ref={(node) => {
        element.current = node
        ref(node)
      }}
      className="artifact-pdf"
      data-trouble={trouble ?? undefined}
    />
  )
}

// A PDF of a pane, drawn page by page once its bytes are in, and its progress till then.
export const PdfViewer = (props: ArtifactBodyProps<"pdf">): React.JSX.Element => {
  const { item, content, itemStore } = props
  const { bytes, loaded, problem } = useSource(props)
  usePaneNote([`PDF · ${bytesText(content.size)}`])
  if (problem === "here" || problem === "failed")
    return (
      <div className="artifact-status" role="alert">
        {problem === "failed"
          ? `${item.name} couldn't be loaded.`
          : `${item.name} can't be shown here.`}
      </div>
    )
  if (problem)
    return (
      <Unavailable
        item={item}
        reason={problem}
        size={content.size}
        onReveal={() => itemStore.reveal(item.id, item.path)}
      />
    )
  return (
    <div className="pdf-pane" aria-busy={bytes === undefined}>
      {bytes !== undefined && (
        <Pages id={`${item.id}\n${item.path}`} name={item.name} bytes={bytes} />
      )}
      {loaded !== null && (
        <div className="pdf-loading" data-over={bytes !== undefined || undefined} role="status">
          <p>{loadingText(loaded, content.size)}</p>
          <Progress label="Loading the PDF" value={loaded} max={content.size} />
        </div>
      )}
    </div>
  )
}
