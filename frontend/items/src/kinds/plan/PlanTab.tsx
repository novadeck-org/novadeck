import {
  pathOf,
  notePattern,
  notesIn,
  type Item,
  type PlanUnwritableReason,
} from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { outline } from "@novadeck/viewers/text"
import { lazy, Suspense, useRef, type ReactNode } from "react"

import { ArtifactMeta, CopyText, MetaPath, Unavailable } from "../../ArtifactViewer"
import type { MarkdownEditorHandle } from "../../document/editor/MarkdownEditor"
import type { PlanActions, ItemStore } from "../../store/item-store"
import { useContent, usePlan } from "../../store/use-item-store"
import { blockOf, currentMarks, unreadableNow, type PlanDoc } from "./plan-doc"

// The editor loads when a plan first opens, so the workspace never pays for it: a
// Markdown document's, with the plan's notes, which load with it.
const PlanEditor = lazy(() =>
  import("./plan-editor/PlanEditor").then((module) => ({ default: module.PlanEditor })),
)

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

// The headings in the file, with what the latest revision changed and where notes are.
const PlanOutline = ({
  plan,
  jump,
}: {
  plan: PlanDoc
  jump: (at: number) => void
}): React.JSX.Element | null => {
  const headings = outline(plan.text)
  if (!headings.length) return null
  const marks = plan.showChanges ? currentMarks(plan) : []
  const notes = [...plan.text.matchAll(notePattern)].map((match) => match.index)
  // Each heading's section runs to the next heading.
  const sections = headings.map((heading, index) => ({
    ...heading,
    end: headings[index + 1]?.at ?? plan.text.length,
  }))
  return (
    <nav className="spine" aria-label="Plan outline">
      <p className="spine-label">Contents</p>
      <ul className="spine-context">
        {sections.map((section) => {
          const count = notes.filter((at) => at >= section.at && at < section.end).length
          const changed = marks.some((mark) => mark.from < section.end && mark.to > section.at)
          return (
            <li key={section.at}>
              <button onClick={() => jump(section.at)} data-changed={changed}>
                <span>{section.text}</span>
                {count > 0 && <em aria-label={plural(count, "note")}>{count}</em>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// Why the person's edits can't be saved, and what's left to them. A plan in an agent's
// messages reads as it does when it's read-only from the start.
const blockedText = (reason: PlanUnwritableReason, agent: string): string => {
  switch (reason) {
    case "gone":
      return "This plan's file was deleted, so your edits can't be saved. Your edits are kept here until you close this plan."
    case "folder":
      return "Novadeck can't write to this plan's folder, so your edits can't be saved. Your edits are kept here until you close this plan."
    case "too-large":
      return "This plan is too large for Novadeck to save your edits. Your edits are kept here until you close this plan."
    case "not-a-plan":
      return "Novadeck can't write to this, since it isn't a plan file, so your edits can't be saved. Your edits are kept here until you close this plan."
    case "transcript":
      return readOnlyText(agent)
  }
}

const readOnlyText = (agent: string): string =>
  `Read-only: this plan lives in ${agent}'s messages, not a file, so notes can't go in it.`

// The edits that can't reach the file, with the ways out: copy them, or try again.
const PlanNotice = ({
  text,
  edits,
  retry,
  retryLabel,
}: {
  text: string
  edits: string
  retry: () => void
  retryLabel: string
}): React.JSX.Element => (
  <div className="plan-notice" role="status">
    <p>{text}</p>
    <div className="plan-notice-actions">
      <CopyText text={edits} label="Copy my edits" />
      <button type="button" className="artifact-open" onClick={retry}>
        {retryLabel}
      </button>
    </div>
  </div>
)

const PlanBody = ({
  item,
  plan,
  block,
  unreadable,
  actions,
  pane,
}: {
  item: Item
  plan: PlanDoc
  // Why saving can't work, if it can't.
  block: PlanUnwritableReason | null
  // The file can't be read for now, which may pass.
  unreadable: boolean
  actions: ReactNode
  pane: PlanActions
}): React.JSX.Element => {
  const editor = useRef<MarkdownEditorHandle | null>(null)
  const marks = currentMarks(plan)
  const agent = item.plan?.agent ?? "The agent"
  // A plan the runner says lives in messages reads as one that was read-only from the start.
  const readOnly = !plan.writable || block === "transcript"
  // The edits as the file would hold them, with its line breaks.
  const copyable = plan.eol === "\n" ? plan.text : plan.text.replaceAll("\n", plan.eol)
  // The header every viewer has, across the pane, then the outline beside the plan.
  return (
    <>
      <ArtifactMeta actions={actions}>
        {pathOf(item) === null ? (
          <span className="artifact-meta-name" title={item.detail || item.name}>
            {item.detail || item.name}
          </span>
        ) : (
          <MetaPath path={pathOf(item)!} />
        )}
        <span>v{item.version}</span>
        {marks.length > 0 && (
          <button
            className="plan-changes-toggle"
            data-tone="warning"
            aria-pressed={plan.showChanges}
            onClick={pane.toggleChanges}
          >
            <i aria-hidden="true" />
            {plural(plan.changes, "change")} since you last read
            <span>{plan.showChanges ? "Hide" : "Show"}</span>
          </button>
        )}
        {plan.unsaved && !plan.stalled && !block && !unreadable && (
          <span className="pane-meta-hint">Not saved yet. Trying again.</span>
        )}
        {plan.resolved > 0 && plan.marked === plan.text && (
          <span>
            {agent} resolved {plural(plan.resolved, "note")}
          </span>
        )}
        {readOnly && (
          <span className="pane-meta-hint">
            {!plan.writable && plan.truncated && item.plan?.source === "file"
              ? "Read-only: it's too long to edit here."
              : readOnlyText(agent)}
          </span>
        )}
        {plan.truncated && (
          <span className="pane-meta-hint">It's long, so only its start is shown.</span>
        )}
        {/* Without Novadeck's skill, notes wait for the person to point the agent at them. */}
        {plan.writable && !plan.skill && notesIn(plan.text) > 0 && (
          <span className="pane-meta-hint">
            {agent} doesn't have Novadeck's skill. Ask it to re-read the plan.
          </span>
        )}
      </ArtifactMeta>
      {!readOnly && block && (
        <PlanNotice
          text={blockedText(block, agent)}
          edits={copyable}
          retry={pane.retry}
          retryLabel="Try saving again"
        />
      )}
      {!readOnly && !block && unreadable && (
        <PlanNotice
          text="Novadeck can't read this plan right now, so your edits can't be saved. Your edits are kept here until you close this plan."
          edits={copyable}
          retry={pane.retry}
          retryLabel="Retry"
        />
      )}
      {!readOnly && !block && !unreadable && plan.stalled && (
        <PlanNotice
          text="Novadeck couldn't save your edits after 5 tries."
          edits={copyable}
          retry={pane.retry}
          retryLabel="Retry"
        />
      )}
      <div className="pane-reader-body" data-outline={outline(plan.text).length > 0}>
        <PlanOutline plan={plan} jump={(at) => editor.current?.jumpTo(at)} />
        <div className="pane-document-scroll" data-changes={plan.showChanges}>
          <Suspense fallback={null}>
            <PlanEditor
              id={item.id}
              readOnly={readOnly}
              text={plan.text}
              marks={marks}
              onChange={pane.edit}
              onReady={(handle) => {
                editor.current = handle
              }}
              onClose={pane.closeEditor}
            />
          </Suspense>
        </div>
      </div>
    </>
  )
}

// One plan, edited where it's read, with its outline: in the pane, or in a window of its
// own once undocked. Or why it can't show, once its plan is gone.
export const PlanTab = ({
  itemStore,
  target,
  item,
  actions,
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  item: Item
  // What the place showing the plan offers, at the end of its header.
  actions?: ReactNode
}): React.JSX.Element => {
  const plan = usePlan(itemStore, item.id)
  const content = useContent(itemStore, target, item)
  // A plan whose file is gone or can't be read still shows the person's edits, which have
  // nowhere to go.
  const kept =
    plan !== undefined &&
    plan.text !== plan.base &&
    (blockOf(plan, content) === "gone" || unreadableNow(content))
  if (content?.state === "unavailable" && !kept)
    return <Unavailable item={item} reason={content.reason} size={content.size} actions={actions} />
  return plan ? (
    // A plan that becomes writable, or stops being so, keeps its editor, history and place.
    <PlanBody
      item={item}
      plan={plan}
      block={blockOf(plan, content)}
      unreadable={unreadableNow(content)}
      actions={actions}
      pane={itemStore.plan(target, item.id)}
    />
  ) : (
    <div className="artifact-status" />
  )
}
