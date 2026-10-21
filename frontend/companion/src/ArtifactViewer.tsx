import {
  pathOf,
  type ArtifactKind,
  type CompanionItem,
  type PageTrouble,
  type ShownContent,
  type UnavailableReason,
} from "@novadeck/core/companion"
import { useEffect, useState, type ComponentType, type ReactNode } from "react"

import type { ItemMember } from "./bar"
import type { ThumbProps, ViewProps } from "./registration"
import type { Panes } from "./state"
import { useContent } from "./use-panes"

// What the artifact kinds share: the chrome around what an agent showed beside its terminal
// (the states of what hasn't loaded or can't show, and why), and the two components that
// give each kind its pane and its peek miniature from a body of its own. The viewers
// themselves are the kinds' (`panes/image`, `panes/file`, `panes/page`): each loads from the
// file or page it points at now, or says why it can't show.

// What the place showing an artifact offers for it, at the end of its viewer's header.
type Actions = { actions?: ReactNode }

// What an artifact kind's body is given once its content is ready.
export type ArtifactBodyProps<K extends ArtifactKind> = {
  readonly item: CompanionItem
  readonly content: Extract<ShownContent, { readonly kind: K }>
  readonly actions: ReactNode
  readonly panes: Panes
  // Tells what went wrong on a live page, from the item's show `shown`.
  readonly trouble: (shown: number, troubles: readonly PageTrouble[]) => void
}

// An artifact's name as the peek and menu say it, and its button reads.
export const artifactLook = ({
  item,
}: {
  readonly item: Pick<CompanionItem, "name">
}): { readonly name: string; readonly label: string } => ({ name: item.name, label: item.name })

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
  held: "May hold secrets. Click to open.",
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
    case "held":
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
// secrets shows once the person asks.
export const Unavailable = ({
  item,
  reason,
  size,
  onReveal,
  actions,
}: Actions & {
  item: Pick<CompanionItem, "name" | "path" | "plan">
  reason: UnavailableReason
  size: number | null
  onReveal?: (() => void) | undefined
}): React.JSX.Element => (
  <div className="artifact-unavailable" data-reason={reason}>
    <p>{reasonText(reason, item.name, size)}</p>
    <div className="artifact-unavailable-actions">
      {reason === "held" && onReveal && (
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
export const artifactView = <K extends ArtifactKind>(
  kind: K,
  Body: ComponentType<ArtifactBodyProps<K>>,
  document?: (content: Extract<ShownContent, { readonly kind: K }>) => boolean,
): ComponentType<ViewProps<ItemMember>> => {
  const View = ({ member, panes, target, actions }: ViewProps<ItemMember>): React.JSX.Element => {
    const { item } = member
    const load = useContent(panes, target, item)
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
            onReveal={() => panes.reveal(item.id)}
            actions={actions}
          />
        ) : content ? (
          <Body
            item={item}
            content={content}
            actions={actions}
            panes={panes}
            trouble={(shown, troubles) => panes.trouble(target, item.id, shown, troubles)}
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

type ThumbBody<K extends ArtifactKind> = ComponentType<{
  readonly content: Extract<ShownContent, { readonly kind: K }>
}>

const LoadedThumb = <K extends ArtifactKind>({
  kind,
  Body,
  member,
  panes,
  target,
}: ThumbProps<ItemMember> & { kind: K; Body: ThumbBody<K> }): React.JSX.Element | null => {
  const load = useContent(panes, target, member.item)
  if (!load) return null
  if (load.state === "unavailable")
    return <span className="peek-held">{shortReasons[load.reason]}</span>
  const { content } = load
  return content.kind === kind ? (
    <Body content={content as Extract<ShownContent, { readonly kind: K }>} />
  ) : null
}

const ArtifactThumb = <K extends ArtifactKind>(
  props: ThumbProps<ItemMember> & { kind: K; Body: ThumbBody<K> },
): React.JSX.Element | null =>
  // A held one is never loaded for a peek, which a passing pointer opens.
  props.member.item.held ? (
    <span className="peek-held">May hold secrets. Click to open.</span>
  ) : (
    <LoadedThumb {...props} />
  )

// A small picture of an artifact, for a peek, from the kind's `Body`: or why it can't show.
// Blank until it loads.
export const artifactThumb = <K extends ArtifactKind>(
  kind: K,
  Body: ThumbBody<K>,
): ComponentType<ThumbProps<ItemMember>> => {
  const Thumb = (props: ThumbProps<ItemMember>): React.JSX.Element | null => (
    <ArtifactThumb {...props} kind={kind} Body={Body} />
  )
  return Thumb
}
