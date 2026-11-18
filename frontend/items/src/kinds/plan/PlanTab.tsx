import { notePattern, notesIn, type Item, type PlanUnwritableReason } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { outline } from "@novadeck/viewers/text"
import { Diff } from "lucide-react"
import { lazy, Suspense, useRef } from "react"

import { CopyText, Unavailable } from "../../ArtifactViewer"
import type { MarkdownEditorHandle } from "../../document/editor/MarkdownEditor"
import { PaneTools, usePaneNote } from "../../pane-row"
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
    case "outside":
      return "Novadeck saves plans only in the project's folder or the agent's own plans folder, and this one is elsewhere, so your edits can't be saved. Your edits are kept here until you close this plan."
    case "transcript":
      return readOnlyText(agent)
  }
}

const readOnlyText = (agent: string): string =>
  `Read-only: this plan lives in ${agent}'s messages, not a file, so notes can't go in it.`

// The one line of words under the row, when the plan can't be saved or can't be edited: what's
// wrong, and the ways out where there are any (copy the edits, try again).
const PlanNotice = ({
  text,
  edits,
  retry,
}: {
  text: string
  // The person's edits to copy, and the try again, where the plan can be saved but isn't.
  edits?: string
  retry?: { readonly run: () => void; readonly label: string }
}): React.JSX.Element => (
  <div className="pane-notice" data-tone="warning" role="status">
    <p>{text}</p>
    {(edits !== undefined || retry) && (
      <div className="pane-notice-actions">
        {edits !== undefined && <CopyText text={edits} label="Copy my edits" />}
        {retry && (
          <button type="button" className="artifact-open" onClick={retry.run}>
            {retry.label}
          </button>
        )}
      </div>
    )}
  </div>
)

const PlanBody = ({
  item,
  plan,
  block,
  unreadable,
  pane,
}: {
  item: Item
  plan: PlanDoc
  // Why saving can't work, if it can't.
  block: PlanUnwritableReason | null
  // The file can't be read for now, which may pass.
  unreadable: boolean
  pane: PlanActions
}): React.JSX.Element => {
  const editor = useRef<MarkdownEditorHandle | null>(null)
  const marks = currentMarks(plan)
  const agent = item.plan?.agent ?? "The agent"
  // A plan the runner says lives in messages reads as one that was read-only from the start.
  const readOnly = !plan.writable || block === "transcript"
  // The edits as the file would hold them, with its line breaks.
  const copyable = plan.eol === "\n" ? plan.text : plan.text.replaceAll("\n", plan.eol)
  const resolved =
    plan.resolved > 0 && plan.marked === plan.text
      ? [`${agent} resolved ${plural(plan.resolved, "note")}`]
      : []
  usePaneNote(resolved)
  const changes = `${plural(plan.changes, "change")} since you last read`
  // The one line of words: what keeps the edits from the file, else what keeps the plan from
  // being edited or read whole. Each is its own notice, so one that gives way to another is gone
  // before it comes back.
  const notice =
    !readOnly && block ? (
      <PlanNotice
        key="blocked"
        text={blockedText(block, agent)}
        edits={copyable}
        retry={{ run: pane.retry, label: "Try saving again" }}
      />
    ) : !readOnly && unreadable ? (
      <PlanNotice
        key="unreadable"
        text="Novadeck can't read this plan right now, so your edits can't be saved. Your edits are kept here until you close this plan."
        edits={copyable}
        retry={{ run: pane.retry, label: "Retry" }}
      />
    ) : !readOnly && plan.stalled ? (
      <PlanNotice
        key="stalled"
        text="Novadeck couldn't save your edits after 5 tries."
        edits={copyable}
        retry={{ run: pane.retry, label: "Retry" }}
      />
    ) : !readOnly && plan.unsaved ? (
      <PlanNotice key="unsaved" text="Not saved yet. Trying again." />
    ) : readOnly ? (
      <PlanNotice
        key="read-only"
        text={
          !plan.writable && plan.truncated && item.plan?.source === "file"
            ? "Read-only: it's too long to edit here."
            : readOnlyText(agent)
        }
      />
    ) : plan.truncated ? (
      <PlanNotice key="long" text="It's long, so only its start is shown." />
    ) : // Without Novadeck's skill, notes wait for the person to point the agent at them.
    !plan.skill && notesIn(plan.text) > 0 ? (
      <PlanNotice
        key="skill"
        text={`${agent} doesn't have Novadeck's skill. Ask it to re-read the plan.`}
      />
    ) : null
  return (
    <>
      <PaneTools
        tools={
          marks.length > 0
            ? [
                {
                  key: "changes",
                  icon: Diff,
                  label: `${plan.showChanges ? "Hide" : "Show"} the ${changes}`,
                  pressed: plan.showChanges,
                  badge: plan.changes,
                  onClick: pane.toggleChanges,
                },
              ]
            : []
        }
      />
      {notice}
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
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  item: Item
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
    return <Unavailable item={item} reason={content.reason} size={content.size} />
  return plan ? (
    // A plan that becomes writable, or stops being so, keeps its editor, history and place.
    <PlanBody
      item={item}
      plan={plan}
      block={blockOf(plan, content)}
      unreadable={unreadableNow(content)}
      pane={itemStore.plan(target, item.id)}
    />
  ) : (
    <div className="artifact-status" />
  )
}
