import { FileText, Image } from "lucide-react"

import { ContextMenu, type ContextMenuItem } from "../../ui-toolkit/ContextMenu"
import { HoverCard } from "../../ui-toolkit/HoverCard"
import { ArtifactThumb, kindIcons } from "./ArtifactViewer"
import { dismiss, pickFromGroup, planTab, slotsOf, type Shown } from "./pane"
import { Peek, type Indicator, type PeekEntry } from "./Peek"
import { headingsOf, titleOf } from "./plan-text"
import { closePlan, openTab, type CompanionHandle, type PlanState } from "./state"

const indicatorOf = (plan: PlanState, tab: string, fresh: boolean, open: boolean): Indicator =>
  fresh ? "new" : open && plan.tab === tab ? "open" : "seen"

// The plan in miniature: its title over its sections.
const PlanThumb = ({ plan, title }: { plan: PlanState; title: string }): React.JSX.Element => (
  <span className="peek-plan">
    <b>{title}</b>
    {headingsOf(plan.text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
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

// The pane's taskbar along the terminal's bottom: the plan, then what else its agent
// showed, an icon each, images grouped. Hover peeks, click opens or hides, right-click
// dismisses. Nothing opens on its own.
export const Taskbar = ({
  companion,
  trigger,
  open,
}: {
  companion: CompanionHandle
  trigger: React.RefObject<HTMLButtonElement | null>
  open: boolean
}): React.JSX.Element => {
  const { state: plan, plan: file } = companion
  const unread = plan.seen < plan.revision
  const showing = (tab: string): boolean => open && plan.tab === tab
  // Clicking what the pane is showing hides it, as a taskbar minimizes the active window.
  const activate = (tab: string): void =>
    companion.update((state) => (showing(tab) ? closePlan(state) : openTab(state, tab)))
  const menu = (tab: string, dismissable: boolean): ContextMenuItem[] => [
    {
      value: "open",
      label: "Open",
      onSelect: () => companion.update((state) => openTab(state, tab)),
    },
    ...(dismissable
      ? [
          {
            value: "dismiss",
            label: "Dismiss",
            onSelect: () => companion.update((state) => dismiss(state, tab)),
          },
        ]
      : []),
  ]
  const title = titleOf(file.path, plan.text)
  const peekOf = (artifact: Shown): PeekEntry => {
    const Icon = kindIcons[artifact.kind]
    return {
      id: artifact.id,
      name: artifact.name,
      icon: <Icon size={13} strokeWidth={1.5} />,
      preview: <ArtifactThumb artifact={artifact} />,
      state: indicatorOf(plan, artifact.id, artifact.fresh, open),
      onOpen: () => companion.update((state) => openTab(state, artifact.id)),
      onDismiss: () => companion.update((state) => dismiss(state, artifact.id)),
    }
  }
  return (
    <div
      className="plan-taskbar nodrag nopan"
      data-workspace-companion
      role="group"
      aria-label={`What ${file.agent} showed you`}
      // Opening leaves focus here, so Escape hides the pane from here too.
      onKeyDown={(event) => {
        // Keys from its menus and peeks bubble here through React's portals; theirs is
        // their own Escape.
        if (event.key !== "Escape" || !open) return
        if (!event.currentTarget.contains(event.target as Node)) return
        event.stopPropagation()
        companion.update(closePlan)
      }}
    >
      {slot(
        "plan",
        "Plan",
        menu(planTab, false),
        <button
          ref={trigger}
          className="plan-tb-item"
          data-state={indicatorOf(plan, planTab, unread, open)}
          aria-label={`Plan: ${title}${unread ? ", new" : ""}`}
          aria-pressed={showing(planTab)}
          onClick={() => activate(planTab)}
        >
          <FileText size={20} strokeWidth={1.5} />
        </button>,
        <Peek
          entries={[
            {
              id: planTab,
              // Named by its file, like everything else; the preview carries the title.
              name: file.path.split("/").at(-1)!,
              icon: <FileText size={13} strokeWidth={1.5} />,
              preview: <PlanThumb plan={plan} title={title} />,
              state: indicatorOf(plan, planTab, unread, open),
              onOpen: () => companion.update((state) => openTab(state, planTab)),
            },
          ]}
        />,
      )}
      {slotsOf(plan.artifacts).map((entry) => {
        if (entry.kind === "one") {
          const { artifact } = entry
          const Icon = kindIcons[artifact.kind]
          return slot(
            artifact.id,
            artifact.name,
            menu(artifact.id, true),
            <button
              className="plan-tb-item"
              data-state={indicatorOf(plan, artifact.id, artifact.fresh, open)}
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
        const current = images.find((shown) => showing(shown.id))
        return slot(
          "images",
          "Images",
          images.flatMap((image) => [
            {
              value: `open-${image.id}`,
              label: `Open ${image.name}`,
              onSelect: () => companion.update((state) => openTab(state, image.id)),
            },
            {
              value: `dismiss-${image.id}`,
              label: `Dismiss ${image.name}`,
              onSelect: () => companion.update((state) => dismiss(state, image.id)),
            },
          ]),
          <button
            className="plan-tb-item"
            data-state={fresh ? "new" : current ? "open" : "seen"}
            aria-label={`${images.length} images${fresh ? ", new" : ""}`}
            aria-pressed={Boolean(current)}
            onClick={() => activate(pickFromGroup(plan, images).id)}
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
