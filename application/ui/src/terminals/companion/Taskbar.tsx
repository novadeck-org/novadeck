import { FileStack, FileText, Image } from "lucide-react"

import { ContextMenu, type ContextMenuItem } from "../../ui-toolkit/ContextMenu"
import { HoverCard } from "../../ui-toolkit/HoverCard"
import { ArtifactThumb, kindIcons } from "./ArtifactViewer"
import { dismiss, pickFromGroup, planTab, slotsOf, type Shown } from "./pane"
import { Peek, type Indicator, type PeekEntry } from "./Peek"
import { headingsOf, titleOf } from "./plan-text"
import {
  closePane,
  openTab,
  shownTab,
  unread,
  useArtifactContent,
  type CompanionHandle,
  type PlanDoc,
} from "./state"

// The plan in miniature: its title over its sections.
const PlanThumb = ({ plan }: { plan: PlanDoc }): React.JSX.Element => (
  <span className="peek-plan">
    <b>{titleOf(plan.path, plan.text)}</b>
    {headingsOf(plan.text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
)

const LoadedPreview = ({
  companion,
  artifact,
}: {
  companion: CompanionHandle
  artifact: Shown
}): React.JSX.Element | null => <ArtifactThumb load={useArtifactContent(companion, artifact)} />

// An artifact in miniature, once it loads; a held one is never loaded for a peek, which
// a passing pointer opens.
const ArtifactPreview = ({
  companion,
  artifact,
}: {
  companion: CompanionHandle
  artifact: Shown
}): React.JSX.Element | null =>
  artifact.held ? (
    <span className="peek-held">May hold secrets. Click to open.</span>
  ) : (
    <LoadedPreview companion={companion} artifact={artifact} />
  )

// A taskbar slot: its icon, the peek above it, and its menu, which is also the
// keyboard's way to everything the peek offers.
const slot = (
  key: string,
  label: string,
  items: ContextMenuItem[],
  button: React.ReactElement,
  peek: React.ReactNode,
): React.JSX.Element => (
  <ContextMenu
    key={key}
    label={`${label} actions`}
    items={items}
    trigger={
      <span className="plan-tb-slot">
        <HoverCard trigger={button} className="plan-tb-peek">
          {peek}
        </HoverCard>
      </span>
    }
  />
)

// The pane's taskbar along the terminal's bottom: its plans, the agent's own first, then
// what else the agent showed, an icon each, images grouped. Hover peeks, click opens or
// hides, the menu opens or dismisses. Nothing opens on its own.
export const Taskbar = ({
  companion,
  trigger,
  open,
}: {
  companion: CompanionHandle
  trigger: React.RefObject<HTMLButtonElement | null>
  open: boolean
}): React.JSX.Element => {
  const { pane } = companion
  const current = shownTab(pane)
  const showing = (tab: string): boolean => open && current === tab
  const state = (tab: string, fresh: boolean): Indicator =>
    fresh ? "new" : showing(tab) ? "open" : "seen"
  // Clicking what the pane is showing hides it, as a taskbar minimizes the active window.
  const activate = (tab: string): void =>
    companion.update((next) => (showing(tab) ? closePane(next) : openTab(next, tab)))
  const opening = (tab: string, label = "Open"): ContextMenuItem => ({
    value: `open-${tab}`,
    label,
    onSelect: () => companion.update((next) => openTab(next, tab)),
  })
  const dismissing = (id: string, label = "Dismiss"): ContextMenuItem => ({
    value: `dismiss-${id}`,
    label,
    onSelect: () => companion.update((next) => dismiss(next, id)),
  })
  const peekOf = (artifact: Shown): PeekEntry => {
    const Icon = kindIcons[artifact.kind]
    return {
      id: artifact.id,
      name: artifact.name,
      icon: <Icon size={13} strokeWidth={1.5} />,
      preview: <ArtifactPreview companion={companion} artifact={artifact} />,
      state: state(artifact.id, artifact.fresh),
      onOpen: () => companion.update((next) => openTab(next, artifact.id)),
      onDismiss: () => companion.update((next) => dismiss(next, artifact.id)),
    }
  }
  const agent = pane.plans[0]?.agent ?? "The agent"
  const slots = slotsOf(pane.artifacts)
  // Focus comes back to the first icon when the pane hides: the agent's own plan, or
  // the first thing it showed when it has no plan.
  const firstSlot = slots[0]
  return (
    <div
      className="plan-taskbar nodrag nopan"
      data-workspace-companion
      role="group"
      aria-label={`What ${agent} showed you`}
      // Opening leaves focus here, so Escape hides the pane from here too.
      onKeyDown={(event) => {
        // Keys from its menus and peeks bubble here through React's portals; theirs is
        // their own Escape.
        if (event.key !== "Escape" || !open) return
        if (!event.currentTarget.contains(event.target as Node)) return
        event.stopPropagation()
        companion.update(closePane)
      }}
    >
      {pane.plans.map((plan, index) => {
        const tab = planTab(plan.ref)
        const title = titleOf(plan.path, plan.text)
        const fresh = unread(plan)
        const Icon = plan.role === "root" ? FileText : FileStack
        const kind = plan.role === "root" ? "Plan" : "Subagent plan"
        return slot(
          tab,
          kind,
          [opening(tab)],
          <button
            // Focus comes back to the agent's own plan when the pane hides.
            ref={index === 0 ? trigger : undefined}
            className="plan-tb-item"
            data-state={state(tab, fresh)}
            aria-label={`${kind}: ${title}${fresh ? ", new" : ""}`}
            aria-pressed={showing(tab)}
            onClick={() => activate(tab)}
          >
            <Icon size={20} strokeWidth={1.5} />
          </button>,
          <Peek
            entries={[
              {
                id: tab,
                // Named by its file, like everything else; the preview carries the title.
                name: plan.path.split("/").at(-1)!,
                icon: <Icon size={13} strokeWidth={1.5} />,
                preview: <PlanThumb plan={plan} />,
                state: state(tab, fresh),
                onOpen: () => companion.update((next) => openTab(next, tab)),
              },
            ]}
          />,
        )
      })}
      {slots.map((entry) => {
        if (entry.kind === "one") {
          const { artifact } = entry
          const Icon = kindIcons[artifact.kind]
          return slot(
            artifact.id,
            artifact.name,
            [opening(artifact.id), dismissing(artifact.id)],
            <button
              ref={pane.plans.length || entry !== firstSlot ? undefined : trigger}
              className="plan-tb-item"
              data-state={state(artifact.id, artifact.fresh)}
              aria-label={`${artifact.name}${artifact.fresh ? ", new" : ""}`}
              aria-pressed={showing(artifact.id)}
              onClick={() => activate(artifact.id)}
            >
              <Icon size={20} strokeWidth={1.5} />
            </button>,
            <Peek entries={[peekOf(artifact)]} />,
          )
        }
        const images = entry.artifacts
        const fresh = images.some((shown) => shown.fresh)
        const openImage = images.find((shown) => showing(shown.id))
        return slot(
          "images",
          "Images",
          images.flatMap((image) => [
            opening(image.id, `Open ${image.name}`),
            dismissing(image.id, `Dismiss ${image.name}`),
          ]),
          <button
            ref={pane.plans.length || entry !== firstSlot ? undefined : trigger}
            className="plan-tb-item"
            data-state={fresh ? "new" : openImage ? "open" : "seen"}
            aria-label={`${images.length} images${fresh ? ", new" : ""}`}
            aria-pressed={Boolean(openImage)}
            onClick={() => activate(pickFromGroup(pane, images).id)}
          >
            <Image size={20} strokeWidth={1.5} />
            <b className="plan-tb-count" aria-hidden="true">
              {images.length}
            </b>
          </button>,
          <Peek entries={images.map(peekOf)} />,
        )
      })}
    </div>
  )
}
