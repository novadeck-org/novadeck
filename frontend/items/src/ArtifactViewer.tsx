import { bytesText } from "@novadeck/core/command-text"
import {
  pathOf,
  type ShownKind,
  type Item,
  type PageTrouble,
  type ShownContent,
  type UnavailableReason,
} from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useState, type ComponentType } from "react"

import { usePaneNote } from "./pane-row"
import type { ItemProps, ViewProps } from "./registration"
import type { ItemStore } from "./store/item-store"
import { useContent } from "./store/use-item-store"

// What the artifact kinds share: the states of what an agent showed beside its terminal that
// hasn't loaded or can't show, and why (the row above them is the place's, see pane-row.tsx), and the two components that
// give each kind its pane and its peek miniature from a body of its own. The viewers
// themselves are the kinds' (`kinds/image`, `kinds/file`, `kinds/page`): each loads from the
// file or page it points at now, or says why it can't show.

// What an artifact kind's body is given once its content is ready.
export type ArtifactBodyProps<K extends ShownKind> = {
  readonly item: Item
  readonly content: Extract<ShownContent, { readonly kind: K }>
  readonly itemStore: ItemStore
  // The content's stamp, which changes with it.
  readonly stamp: string
  // Where the content is shown, which its calls to the backend are made for.
  readonly target: WorkspaceTarget
  // Tells what went wrong on a live page, from the item's show `shown`.
  readonly trouble: (shown: number, troubles: readonly PageTrouble[]) => void
}

// An artifact's name as the peek and menu say it, and its button reads.
export const artifactLook = (
  item: Pick<Item, "name">,
): { readonly name: string; readonly label: string } => ({ name: item.name, label: item.name })

// Why it can't show, in a few words, as a peek says it.
const shortReasons: Record<UnavailableReason, string> = {
  missing: "Not there any more",
  unreadable: "Can't be read",
  "not-a-file": "Not a file",
  "too-large": "Too large to preview",
  binary: "Not text",
  secret: "May hold secrets. Click to open.",
  gone: "Gone",
}

// The largest file a kind previews, where the pane says it: the runner's `pdfLimits` and
// `modelLimits`.
const largest: Partial<Record<Item["kind"], string>> = {
  pdf: "Novadeck previews PDFs up to 128 MB.",
  model: "Novadeck previews 3D models up to 256 MB, with the files beside them they name.",
}

// Why it can't show, as the pane says it.
const reasonText = (
  reason: UnavailableReason,
  { name, kind }: Pick<Item, "name" | "kind">,
  size: number | null,
): string => {
  switch (reason) {
    case "missing":
      return `${name} isn't there any more.`
    case "unreadable":
      return `Novadeck can't read ${name}.`
    case "not-a-file":
      return `${name} is no longer a file.`
    case "too-large":
      return [
        `${name} is too large to preview${size === null ? "" : ` (${bytesText(size)})`}.`,
        ...(largest[kind] ? [largest[kind]] : []),
      ].join(" ")
    case "binary":
      return `${name} isn't text, so it can't be previewed.`
    case "secret":
      return `${name} may hold secrets, so it shows only when you ask.`
    case "gone":
      return `${name} is gone.`
  }
}

// A button that puts `text` on the clipboard, and says so for a moment.
export const CopyText = ({ text, label }: { text: string; label: string }): React.JSX.Element => {
  const [result, setResult] = useState<"copied" | "failed" | null>(null)
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), 1500)
    return () => clearTimeout(timer)
  }, [result])
  return (
    <button
      type="button"
      className="artifact-open"
      onClick={() => {
        const written = navigator.clipboard?.writeText(text)
        if (!written) return setResult("failed")
        written.then(
          () => setResult("copied"),
          () => setResult("failed"),
        )
      }}
    >
      {result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : label}
    </button>
  )
}

// What can't show, and why, with its path to copy where it has one. One that may hold
// secrets shows once the person asks. A gone one strikes its tab's name through.
export const Unavailable = ({
  item,
  reason,
  size,
  onReveal,
}: {
  item: Pick<Item, "name" | "kind" | "path" | "plan">
  reason: UnavailableReason
  size: number | null
  onReveal?: (() => void) | undefined
}): React.JSX.Element => {
  usePaneNote([], reason === "gone")
  return (
    <div className="artifact-unavailable" data-reason={reason}>
      <p>{reasonText(reason, item, size)}</p>
      <div className="artifact-unavailable-actions">
        {reason === "secret" && onReveal && (
          <button type="button" className="artifact-open" onClick={onReveal}>
            Show it
          </button>
        )}
        {pathOf(item) !== null && <CopyText text={pathOf(item)!} label="Copy path" />}
      </div>
    </div>
  )
}

// The pane's body for an artifact kind, once the kind's `Body` has its content: loads and
// follows what the item holds while it shows, and draws what hasn't loaded or can't show.
export const artifactView = <K extends ShownKind>(
  kind: K,
  Body: ComponentType<ArtifactBodyProps<K>>,
): ComponentType<ViewProps> => {
  const View = ({ item, itemStore, target }: ViewProps): React.JSX.Element => {
    const load = useContent(itemStore, target, item)
    const ready = load?.state === "ready" ? load.content : undefined
    const content =
      ready?.kind === kind ? (ready as Extract<ShownContent, { readonly kind: K }>) : undefined
    return (
      <div className="artifact-viewer" aria-busy={!content && load?.state !== "unavailable"}>
        {load?.state === "unavailable" ? (
          <Unavailable
            item={item}
            reason={load.reason}
            size={load.size}
            onReveal={() => itemStore.reveal(item.id, item.path)}
          />
        ) : content ? (
          <Body
            item={item}
            content={content}
            itemStore={itemStore}
            stamp={load?.state === "ready" ? load.stamp : ""}
            target={target}
            trouble={(shown, troubles) => itemStore.trouble(target, item.id, shown, troubles)}
          />
        ) : (
          // Nothing yet, or content of another kind than the item's, as while the runner
          // reclassifies a persisted item: busy until what fits it arrives.
          <div className="artifact-status" />
        )}
      </div>
    )
  }
  return View
}

// A peek's body: what the item is, and, for one that reads its bytes for a still, where from
// and as which stamp.
type ThumbBody<K extends ShownKind> = ComponentType<{
  readonly content: Extract<ShownContent, { readonly kind: K }>
  readonly item: Item
  readonly itemStore: ItemStore
  readonly target: WorkspaceTarget
  readonly stamp: string
}>

const LoadedThumb = <K extends ShownKind>({
  kind,
  Body,
  item,
  itemStore,
  target,
}: ItemProps & { kind: K; Body: ThumbBody<K> }): React.JSX.Element | null => {
  const load = useContent(itemStore, target, item)
  if (!load) return null
  if (load.state === "unavailable")
    return <span className="peek-held">{shortReasons[load.reason]}</span>
  const { content } = load
  return content.kind === kind ? (
    <Body
      content={content as Extract<ShownContent, { readonly kind: K }>}
      item={item}
      itemStore={itemStore}
      target={target}
      stamp={load.stamp}
    />
  ) : null
}

const ArtifactThumb = <K extends ShownKind>(
  props: ItemProps & { kind: K; Body: ThumbBody<K> },
): React.JSX.Element | null =>
  // A held one is never loaded for a peek, which a passing pointer opens.
  props.item.secret ? (
    <span className="peek-held">May hold secrets. Click to open.</span>
  ) : (
    <LoadedThumb {...props} />
  )

// A small picture of an artifact, for a peek, from the kind's `Body`: or why it can't show.
// Blank until it loads.
export const artifactThumb = <K extends ShownKind>(
  kind: K,
  Body: ThumbBody<K>,
): ComponentType<ItemProps> => {
  const Thumb = (props: ItemProps): React.JSX.Element | null => (
    <ArtifactThumb {...props} kind={kind} Body={Body} />
  )
  return Thumb
}
