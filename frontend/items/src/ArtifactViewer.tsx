import {
  pathOf,
  type ShownKind,
  type Item,
  type PageTrouble,
  type ShownContent,
  type UnavailableReason,
} from "@novadeck/core/items"
import { useEffect, useState, type ComponentType, type ReactNode } from "react"

import type { ItemProps, ViewProps } from "./registration"
import type { ItemStore } from "./state"
import { useContent } from "./use-item-store"

// What the artifact kinds share: the chrome around what an agent showed beside its terminal
// (the states of what hasn't loaded or can't show, and why), and the two components that
// give each kind its pane and its peek miniature from a body of its own. The viewers
// themselves are the kinds' (`kinds/image`, `kinds/file`, `kinds/page`): each loads from the
// file or page it points at now, or says why it can't show.

// What the place showing an artifact offers for it, at the end of its viewer's header.
type Actions = { actions?: ReactNode }

// What an artifact kind's body is given once its content is ready.
export type ArtifactBodyProps<K extends ShownKind> = {
  readonly item: Item
  readonly content: Extract<ShownContent, { readonly kind: K }>
  readonly actions: ReactNode
  readonly itemStore: ItemStore
  // Tells what went wrong on a live page, from the item's show `shown`.
  readonly trouble: (shown: number, troubles: readonly PageTrouble[]) => void
}

// An artifact's name as the peek and menu say it, and its button reads.
export const artifactLook = (
  item: Pick<Item, "name">,
): { readonly name: string; readonly label: string } => ({ name: item.name, label: item.name })

// A size in bytes as a person reads it.
const sizeText = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

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

// Why it can't show, as the pane says it.
const reasonText = (reason: UnavailableReason, name: string, size: number | null): string => {
  switch (reason) {
    case "missing":
      return `${name} isn't there any more.`
    case "unreadable":
      return `Novadeck can't read ${name}.`
    case "not-a-file":
      return `${name} is no longer a file.`
    case "too-large":
      return `${name} is too large to preview${size === null ? "" : ` (${sizeText(size)})`}.`
    case "binary":
      return `${name} isn't text, so it can't be previewed.`
    case "secret":
      return `${name} may hold secrets, so it shows only when you ask.`
    case "gone":
      return `${name} is gone.`
  }
}

// The header every viewer has: what it shows and what's known about it, wrapping onto more
// lines as it must, then `actions`, which stay at the end of its first line however long
// what it shows is named.
export const ArtifactMeta = ({
  className,
  children,
  actions,
}: Actions & { className?: string; children: ReactNode }): React.JSX.Element => (
  <div className={className ? `artifact-meta ${className}` : "artifact-meta"}>
    <div className="artifact-meta-info">{children}</div>
    {actions}
  </div>
)

// A path at the start of a viewer's header, whole on hover: too long for the header, it
// gives up its start, so its file's name stays.
export const MetaPath = ({ path }: { path: string }): React.JSX.Element => (
  <code className="artifact-meta-name artifact-meta-path" title={path}>
    <bdi dir="ltr">{path}</bdi>
  </code>
)

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
// secrets shows once the person asks.
export const Unavailable = ({
  item,
  reason,
  size,
  onReveal,
  actions,
}: Actions & {
  item: Pick<Item, "name" | "path" | "plan">
  reason: UnavailableReason
  size: number | null
  onReveal?: (() => void) | undefined
}): React.JSX.Element => (
  <div className="artifact-unavailable" data-reason={reason}>
    <p>{reasonText(reason, item.name, size)}</p>
    <div className="artifact-unavailable-actions">
      {reason === "secret" && onReveal && (
        <button type="button" className="artifact-open" onClick={onReveal}>
          Show it
        </button>
      )}
      {pathOf(item) !== null && <CopyText text={pathOf(item)!} label="Copy path" />}
      {actions}
    </div>
  </div>
)

// The pane's body for an artifact kind, once the kind's `Body` has its content: loads and
// follows what the item holds while it shows, and draws what hasn't loaded or can't show.
// `document` marks the content a place shows as a document, which the stylesheet reads.
export const artifactView = <K extends ShownKind>(
  kind: K,
  Body: ComponentType<ArtifactBodyProps<K>>,
  document?: (content: Extract<ShownContent, { readonly kind: K }>) => boolean,
): ComponentType<ViewProps> => {
  const View = ({ item, itemStore, target, actions }: ViewProps): React.JSX.Element => {
    const load = useContent(itemStore, target, item)
    const ready = load?.state === "ready" ? load.content : undefined
    const content =
      ready?.kind === kind ? (ready as Extract<ShownContent, { readonly kind: K }>) : undefined
    return (
      <div
        className="artifact-viewer"
        aria-busy={!content && load?.state !== "unavailable"}
        data-document={(content && document?.(content)) || undefined}
      >
        {load?.state === "unavailable" ? (
          <Unavailable
            item={item}
            reason={load.reason}
            size={load.size}
            onReveal={() => itemStore.reveal(item.id, item.path)}
            actions={actions}
          />
        ) : content ? (
          <Body
            item={item}
            content={content}
            actions={actions}
            itemStore={itemStore}
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

type ThumbBody<K extends ShownKind> = ComponentType<{
  readonly content: Extract<ShownContent, { readonly kind: K }>
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
    <Body content={content as Extract<ShownContent, { readonly kind: K }>} />
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
