import { pathOf, type Item } from "@novadeck/core/items"
import { handleText } from "@novadeck/core/terminals/handle"
import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Check, Ellipsis, SquareTerminal, type LucideIcon } from "lucide-react"
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react"
import { createPortal } from "react-dom"

// The row on top of every companion pane and window: the tabs of what the pane shows, or its
// one item as a plain title, with the viewer's tools and the place's own buttons at its end.
// The place draws it (a terminal's pane, an undocked window), and the viewer under it adds
// to it from where it is: its tools (`PaneTools`) and what its tab's tooltip says of what it
// shows (`usePaneNote`), so a kind draws no header of its own.

// What the viewer tells its tab: facts for the tooltip beside the ones the item has, and
// that what it shows is gone.
export type TabNote = {
  readonly facts: readonly string[]
  readonly gone: boolean
  // Where it points now, where that isn't where it was shown: a page's live address.
  readonly where: string | undefined
}

const noNote: TabNote = { facts: [], gone: false, where: undefined }

// Where the viewer puts its tools: the row's own spot, null until drawn, and undefined where
// no row is drawn, as when a viewer is drawn on its own.
const ToolsSlot = createContext<HTMLElement | null | undefined>(undefined)
const NoteSetter = createContext<Dispatch<SetStateAction<TabNote>> | undefined>(undefined)

// The row, around what it's the row of. `renderRow` draws the tabs or the title from what the
// viewer told, and `end` what the place offers at the end, which stays there as the tabs scroll.
export const PaneChrome = ({
  renderRow,
  end,
  children,
}: {
  renderRow: (note: TabNote) => ReactNode
  end?: ReactNode
  children?: ReactNode
}): React.JSX.Element => {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [note, setNote] = useState(noNote)
  return (
    <ToolsSlot value={slot}>
      <NoteSetter value={setNote}>
        <div className="pane-row">
          {renderRow(note)}
          <div className="pane-end">
            <span ref={setSlot} className="pane-tools" />
            {end}
          </div>
        </div>
        {children}
      </NoteSetter>
    </ToolsSlot>
  )
}

// Tells the tab of what's shown what its viewer knows of it: `facts` for its tooltip, whether
// it's `gone`, and `where` it points now. Let go as the viewer is.
export const usePaneNote = (facts: readonly string[], gone = false, where?: string): void => {
  const set = useContext(NoteSetter)
  const joined = facts.join("\n")
  useEffect(() => {
    set?.({ facts: joined === "" ? [] : joined.split("\n"), gone, where })
    return () => set?.(noNote)
  }, [set, joined, gone, where])
}

// What the row says of one tab beyond its name and icon.
export type TabLook = {
  // The lines of its tooltip, which a screen reader gets as its description.
  readonly tip: readonly string[]
  // The terminal it was moved here from, by name.
  readonly origin: string | undefined
  // Something's wrong with what it holds, as a shell exited non-zero.
  readonly failed: boolean
}

// What a screen reader gets of a tab beyond its name: its tooltip's lines, and the terminal a
// moved item came from, whether or not it has a tooltip.
export const describeTab = (look: TabLook): string | undefined => {
  const lines = [...look.tip, ...(look.origin === undefined ? [] : [`From ${look.origin}`])]
  return lines.length > 0 ? lines.join(". ") : undefined
}

// The tab's icon and name, as its button and the lone title are drawn: a moved item names the
// terminal it came from after its name, muted.
export const TabFace = ({
  icon: Icon,
  name,
  look,
}: {
  icon: LucideIcon
  name: string
  look: TabLook
}): React.JSX.Element => (
  <>
    <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
    <span className="pane-tab-name">{name}</span>
    {look.origin !== undefined && (
      <span className="pane-tab-origin" aria-hidden="true">
        <SquareTerminal size={12} strokeWidth={1.5} />
        {look.origin}
      </span>
    )}
  </>
)

// One item alone, as a plain title where its tab would be: no tab to pick or close, no mark.
export const PaneTitle = ({
  icon,
  name,
  look,
  gone,
}: {
  icon: LucideIcon
  name: string
  look: TabLook
  gone: boolean
}): React.JSX.Element => (
  <div className="pane-tabs nodrag nopan" data-lone>
    <Tooltip content={look.tip.join("\n")} disabled={look.tip.length === 0}>
      <span
        className="pane-tab"
        data-failed={look.failed || undefined}
        data-gone={gone || undefined}
      >
        <span
          className="pane-tab-open"
          role="heading"
          aria-level={2}
          aria-description={describeTab(look)}
        >
          <TabFace icon={icon} name={name} look={look} />
        </span>
      </span>
    </Tooltip>
  </div>
)

// One tool of a viewer: an icon button, or, with `href`, a link out.
export type PaneTool = {
  readonly key: string
  readonly icon: LucideIcon
  // What it does as a screen reader names it, and, longer, as its tooltip says it.
  readonly label: string
  readonly tip?: string
  readonly onClick?: () => void
  // Opens in the person's browser, never in the pane.
  readonly href?: string
  readonly pressed?: boolean
  // The key that does the same, as `aria-keyshortcuts` names it; its tooltip says it too.
  readonly keys?: string
  readonly disabled?: boolean
  // On its way to something: it takes no clicks, and keeps focus.
  readonly pending?: boolean
  // A count on its corner, as the plan's changes.
  readonly badge?: number
}

// Past this many, the tools fold into one menu while the pane is narrow (pane.css).
const mostBeforeFolding = 2

const ToolButton = ({ tool }: { tool: PaneTool }): React.JSX.Element => {
  const Icon = tool.icon
  const body = (
    <>
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      {tool.badge !== undefined && (
        <span className="pane-tool-badge" aria-hidden>
          {tool.badge}
        </span>
      )}
    </>
  )
  return (
    <Tooltip content={tool.tip ?? tool.label}>
      {tool.href ? (
        <a
          className="icon-button pane-tool"
          href={tool.href}
          target="_blank"
          rel="noreferrer"
          aria-label={tool.label}
        >
          {body}
        </a>
      ) : (
        <button
          type="button"
          className="icon-button pane-tool"
          aria-label={tool.label}
          aria-pressed={tool.pressed}
          aria-keyshortcuts={tool.keys}
          aria-disabled={tool.pending || undefined}
          disabled={tool.disabled}
          onClick={tool.pending ? undefined : tool.onClick}
        >
          {body}
        </button>
      )}
    </Tooltip>
  )
}

// The viewer's tools, at the end of the row before the place's buttons, or where it's drawn
// without a row, at its top. `chip` is a link that isn't a tool, as a change's pull request.
export const PaneTools = ({
  tools,
  chip,
}: {
  tools: readonly PaneTool[]
  chip?: ReactNode
}): React.JSX.Element | null => {
  const slot = useContext(ToolsSlot)
  const folds = tools.length > mostBeforeFolding
  const body = (
    <>
      {chip}
      <span className="pane-tools-inline" data-fold={folds || undefined}>
        {tools.map((tool) => (
          <ToolButton key={tool.key} tool={tool} />
        ))}
      </span>
      {folds && (
        <span className="pane-tools-more">
          <ContextMenu
            label="Tools"
            opensOn="click"
            placement="bottom-end"
            tooltip="More tools"
            trigger={
              <button type="button" className="icon-button pane-tool" aria-label="More tools">
                <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
              </button>
            }
            items={tools.map((tool) => ({
              value: tool.key,
              label: tool.label,
              disabled: tool.disabled === true || tool.pending === true,
              // A tool that's on says so in the menu too.
              ...(tool.pressed && {
                detail: <Check size={12} strokeWidth={1.75} aria-label="On" />,
              }),
              onSelect: () => {
                if (tool.href) window.open(tool.href, "_blank", "noreferrer")
                else tool.onClick?.()
              },
            }))}
          />
        </span>
      )}
    </>
  )
  if (slot === undefined) return <div className="pane-tools pane-tools-alone">{body}</div>
  return slot ? createPortal(body, slot) : null
}

// How long ago, as a tooltip says it.
const agoText = (at: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// What a tab's tooltip says of its item: where it points (`where`, if its viewer knows better
// than the item does), then its facts, then who showed it and when. What a viewer knows that the
// item doesn't (`facts`) goes among the facts. Nothing for what has none, as the shells, and never
// the default (read-only, live). `own` is an item its pane's own terminal showed: its agent isn't
// named there, as the window is its own, only when.
export const tabTip = (
  item: Item,
  facts: readonly string[],
  {
    own = false,
    where,
    now = Date.now(),
  }: { own?: boolean; where?: string | undefined; now?: number } = {},
): string[] => {
  const place =
    where ?? pathOf(item) ?? item.url ?? (item.kind === "plan" ? item.detail || item.name : "")
  const details = [
    ...(item.kind === "plan" ? [`v${item.version}`] : []),
    ...(item.kind === "file" && item.lines ? [`lines ${item.lines.from}–${item.lines.to}`] : []),
    ...((item.kind === "image" ||
      item.kind === "video" ||
      item.kind === "audio" ||
      item.kind === "pdf" ||
      item.kind === "model") &&
    item.detail
      ? [item.detail]
      : []),
    ...facts,
  ]
  const ago = item.kind === "shells" || item.kind === "changes" ? "" : agoText(item.shownAt, now)
  const verb = item.kind === "plan" ? "wrote" : "showed"
  const made =
    item.by === "person"
      ? `You added it${ago && ` ${ago}`}`
      : !ago
        ? ""
        : own || !item.from
          ? `${item.kind === "plan" ? "written" : "shown"} ${ago}`
          : `${handleText(item.from.handle)} ${verb} it ${ago}`
  return [place, [...details, made].filter(Boolean).join(" · ")].filter(Boolean)
}
