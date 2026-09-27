import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react"

export const sidebarListClasses =
  "sidebar-list mt-2.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3"

const sidebarItemClasses =
  "sidebar-item relative flex min-h-17 min-w-0 shrink-0 rounded-control border border-transparent text-ink transition-[background-color,border-color,box-shadow] duration-(--motion-feedback) ease-interface hover:bg-soft focus-within:bg-soft data-[selected=true]:border-line data-[selected=true]:bg-paper data-[selected=true]:shadow-control [&.dragging]:z-50 [&.dragging]:border-line [&.dragging]:bg-paper [&.dragging]:shadow-control before:absolute before:top-2.5 before:bottom-2.5 before:-left-px before:w-0.5 before:rounded-control before:bg-strong before:opacity-0 before:content-[''] before:transition-opacity before:duration-(--motion-state) before:ease-interface data-[selected=true]:before:opacity-100"

export const SidebarItem = ({
  name,
  icon,
  detail,
  selected,
  selectLabel,
  tooltip,
  description,
  onSelect,
  actions,
  editor,
  editing = editor !== undefined,
  ref,
  handleRef,
  className = "",
  ...attributes
}: Omit<ComponentPropsWithoutRef<"div">, "children" | "onSelect"> & {
  name: string
  icon: ReactNode
  detail: ReactNode
  selected: boolean
  selectLabel: string
  tooltip: string
  description?: string
  onSelect: () => void
  actions?: ReactNode
  editor?: ReactNode
  editing?: boolean
  ref?: Ref<HTMLDivElement>
  handleRef?: Ref<HTMLButtonElement>
}): React.JSX.Element => (
  <div
    {...attributes}
    ref={ref}
    className={`${sidebarItemClasses} ${editing ? "flex-col" : ""} ${className}`}
    data-selected={selected}
  >
    <button
      ref={handleRef}
      hidden={editing}
      className="sidebar-item-select flex min-w-0 flex-1 items-start gap-2 rounded-[inherit] px-2.5 py-[9px] text-left text-inherit focus-visible:outline-offset-[-2px]"
      type="button"
      aria-label={selectLabel}
      aria-description={description}
      aria-current={selected ? "true" : undefined}
      title={tooltip}
      onClick={onSelect}
    >
      <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center text-muted">
        {icon}
      </span>
      <span className="sidebar-item-copy flex min-w-0 flex-1 flex-col gap-1">
        <strong className="truncate text-[12px] leading-[18px] font-medium">{name}</strong>
        <span className="sidebar-item-detail flex h-6 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] leading-[18px] text-muted [.sidebar-item:has(.sidebar-item-actions)_&]:pr-[var(--sidebar-actions-space,52px)]">
          {detail}
        </span>
      </span>
    </button>
    {editor}
    {actions && (
      <div className="sidebar-item-actions absolute right-2 bottom-[9px] flex h-6 shrink-0 items-center">
        {actions}
      </div>
    )}
  </div>
)
