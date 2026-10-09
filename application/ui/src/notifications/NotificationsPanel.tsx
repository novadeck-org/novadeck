import {
  CheckCheck,
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  type LucideIcon,
} from "lucide-react"

import { SidebarItem, sidebarListClasses } from "../sidebar/SidebarItem"
import type { Viewing } from "../terminals/unread-state"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { dismissable, type Notification, type NotificationKind } from "./notifications"

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
        <CheckCheck size={15} strokeWidth={1.6} />
      </button>
    </Tooltip>
  )
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
              // The action sits on the row's last line: with a reply under it, that line keeps
              // the room, not the detail line.
              className={
                item.reply ? "notification [--_sidebar-actions-space:0px]" : "notification"
              }
              role="listitem"
              data-notification={item.kind}
              data-notification-key={rowKey(item)}
              name={item.terminalName}
              icon={<Icon size={14} strokeWidth={1.5} />}
              selected={viewing?.context === item.context && viewing.id === item.terminalId}
              selectLabel={`Go to ${item.terminalName}`}
              description={[`${item.status}. ${where}`, item.reply].filter(Boolean).join(". ")}
              tooltip={[item.terminalName, item.status, where, item.reply]
                .filter(Boolean)
                .join("\n")}
              onSelect={reveal}
              detail={
                <span className="notification-where min-w-0 truncate">
                  {words[item.kind]} · {where}
                </span>
              }
              {...(item.reply
                ? {
                    below: (
                      <span
                        className={`notification-reply truncate text-caption leading-[18px] ${dismissable(item.kind) ? "pr-13" : ""}`}
                      >
                        {item.reply}
                      </span>
                    ),
                  }
                : {})}
              {...(dismissable(item.kind)
                ? {
                    actions: (
                      <Tooltip content="Mark read">
                        <button
                          className="notification-dismiss icon-button small dim quiet"
                          type="button"
                          aria-label={`Mark ${item.terminalName} read`}
                          onClick={dismiss}
                        >
                          <Check size={13} strokeWidth={1.5} />
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
