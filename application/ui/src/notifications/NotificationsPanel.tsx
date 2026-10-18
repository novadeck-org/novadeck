import {
  CheckCheck,
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  MessageCircleQuestionMark,
  type LucideIcon,
} from "lucide-react"

import { terminalLabel } from "#core/handle"

import { SidebarItem, sidebarListClasses } from "../sidebar/SidebarItem"
import type { Viewing } from "../terminals/unread-state"
import { HandleChip } from "../ui-toolkit/HandleChip"
import { Tooltip } from "../ui-toolkit/Tooltip"
import {
  dismissable,
  notificationDescription,
  notificationTooltip,
  type Notification,
  type NotificationKind,
} from "./notifications"

// Each kind in a glyph of its own, calm beside the tab's: a question, a permission to
// give, a plan to read, a failure and a finish. sidebar.css tints them as tabs are.
const icons: Readonly<Record<NotificationKind, LucideIcon>> = {
  question: CircleHelp,
  permission: CircleAlert,
  plan: ClipboardList,
  failed: CircleX,
  done: CircleCheck,
}

type NotificationsPanelProps = {
  items: readonly Notification[]
  // The terminal the person is looking at, which is no news to them.
  viewing: Viewing
  onReveal: (notification: Notification) => void
  onDismiss: (notification: Notification) => void
}

// The kind in a word, to lead the row's detail line; its status in full is the tooltip's.
const words: Readonly<Record<NotificationKind, string>> = {
  question: "Question",
  permission: "Permission",
  plan: "Plan",
  failed: "Failed",
  done: "Done",
}

const rowKey = ({ context, terminalId }: Notification): string => `${context}/${terminalId}`

const panelElement = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".notifications-panel")

// After a row goes, a keyboard user is left where the row was: on the next row, the
// previous one for the last, else on the panel itself. A pointer or a terminal that took
// focus since is left alone. Waits a frame for the list to render without the row.
const settleFocus = (next: Notification | undefined): void =>
  void requestAnimationFrame(() => {
    const panel = panelElement()
    const active = document.activeElement
    if (active && active !== document.body && active !== panel) return
    const row = next
      ? [...(panel?.querySelectorAll<HTMLElement>("[data-notification-key]") ?? [])].find(
          (element) => element.dataset.notificationKey === rowKey(next),
        )
      : undefined
    ;(row?.querySelector<HTMLElement>(".sidebar-item-select") ?? panel)?.focus()
  })

// Before a row's own button goes, focus is held on the panel until `settleFocus` picks the
// row: the phone's drawer traps focus and, when the focused button vanishes, sends it to its
// close button, where `settleFocus` would then find it taken.
const holdFocus = (): void => panelElement()?.focus()

// Beside the panel's close button: reads the finishes the panel lists, and no others.
export const MarkAllReadButton = ({
  items,
  onDismissAll,
}: {
  items: readonly Notification[]
  onDismissAll: (shown: readonly Notification[]) => void
}): React.JSX.Element | null => {
  const finishes = items.filter(({ kind }) => dismissable(kind))
  if (finishes.length === 0) return null
  return (
    <Tooltip content="Mark all read">
      <button
        className="icon-button dim quiet size-7"
        type="button"
        aria-label="Mark all read"
        onClick={() => {
          holdFocus()
          onDismissAll(finishes)
          settleFocus(items.find(({ kind }) => !dismissable(kind)))
        }}
      >
        <CheckCheck size={14} strokeWidth={1.6} />
      </button>
    </Tooltip>
  )
}

// The line under the detail: murmur's headline for a request, or for a finish its gist, else
// the start of the reply, where there is one. Murmur's sentences are meant to be read whole,
// so they wrap to two lines; the dismiss button sits at the row's bottom right, hence the
// gist's padding on both. The reply's start stays one line.
const lineUnder = (item: Notification): React.JSX.Element | undefined => {
  if (item.headline)
    return (
      <span className="notification-headline line-clamp-2 text-caption leading-[18px]">
        {item.status}
      </span>
    )
  if (item.gist)
    return (
      <span className="notification-reply notification-gist line-clamp-2 pr-13 text-caption leading-[18px]">
        {item.asks && (
          <MessageCircleQuestionMark
            className="mr-1 inline-block size-3 align-[-2px]"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
        {item.gist}
      </span>
    )
  if (item.reply)
    return (
      <span
        className={`notification-reply truncate text-caption leading-[18px] ${dismissable(item.kind) ? "pr-13" : ""}`}
      >
        {item.reply}
      </span>
    )
  return undefined
}

// Everything across the workspace that asks for the person, as rows of the sidebar.
export const NotificationsPanel = ({
  items,
  viewing,
  onReveal,
  onDismiss,
}: NotificationsPanelProps): React.JSX.Element => (
  <div className="notifications-panel flex min-h-0 min-w-0 w-full flex-1 flex-col" tabIndex={-1}>
    {items.length === 0 ? (
      <p className="notifications-empty px-3 py-3 text-control">Nothing needs you.</p>
    ) : (
      <div
        className={`notifications-list ${sidebarListClasses}`}
        role="list"
        aria-label="Notifications"
      >
        {items.map((item, index) => {
          const Icon = icons[item.kind]
          const where = `${item.projectName} · ${item.sessionName}`
          const reveal = (): void => {
            onReveal(item)
            if (dismissable(item.kind)) settleFocus(items[index + 1] ?? items[index - 1])
          }
          const dismiss = (): void => {
            holdFocus()
            onDismiss(item)
            settleFocus(items[index + 1] ?? items[index - 1])
          }
          return (
            <SidebarItem
              key={`${item.context}/${item.terminalId}`}
              // The action sits on the row's last line: with a reply or its gist under it, that
              // line keeps the room, not the detail line.
              className={
                item.reply || item.gist
                  ? "notification [--_sidebar-actions-space:0px]"
                  : "notification"
              }
              role="listitem"
              data-notification={item.kind}
              data-notification-key={rowKey(item)}
              name={item.terminalName}
              {...(item.handle
                ? {
                    tag: <HandleChip handle={item.handle} />,
                  }
                : {})}
              icon={<Icon size={14} strokeWidth={1.5} />}
              selected={viewing?.context === item.context && viewing.id === item.terminalId}
              selectLabel={`Go to ${terminalLabel(item.terminalName, item.handle)}`}
              // A gist stands in for the reply on the row, not in what it says to a screen reader
              // or on hover.
              description={notificationDescription(item)}
              tooltip={notificationTooltip(item)}
              onSelect={reveal}
              detail={
                <span className="notification-where min-w-0 truncate">
                  {words[item.kind]} · {where}
                </span>
              }
              below={lineUnder(item)}
              {...(dismissable(item.kind)
                ? {
                    actions: (
                      <Tooltip content="Mark read">
                        <button
                          className="notification-dismiss icon-button small dim quiet"
                          type="button"
                          aria-label={`Mark ${terminalLabel(item.terminalName, item.handle)} read`}
                          onClick={dismiss}
                        >
                          <Check size={14} strokeWidth={1.5} />
                        </button>
                      </Tooltip>
                    ),
                  }
                : {})}
            />
          )
        })}
      </div>
    )}
  </div>
)
