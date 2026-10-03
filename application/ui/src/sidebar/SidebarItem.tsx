import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react"

export const sidebarListClasses =
  "sidebar-list mt-2.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3"

// An item (the item recipe draws it, its selection bar included); sidebar.css adds the
// row's own looks.
const sidebarItemClasses =
  "item sidebar-item relative flex min-h-17 min-w-0 shrink-0 [&.dragging]:z-50"

export const SidebarItem = ({
  name,
  icon,
  detail,
  selected,
  selectLabel,
  tooltip,
  description,
  badge,
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
  // Beside the name, as a count of what waits there.
  badge?: ReactNode
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
      className="sidebar-item-select flex min-w-0 flex-1 items-start gap-2 px-2.5 py-[9px] text-left"
      type="button"
      aria-label={selectLabel}
      aria-description={description}
      aria-current={selected ? "true" : undefined}
      title={tooltip}
      onClick={onSelect}
    >
      <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="sidebar-item-copy flex min-w-0 flex-1 flex-col gap-1">
        {badge ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate text-[12px] leading-[18px] font-medium">{name}</strong>
            {badge}
          </span>
        ) : (
          <strong className="truncate text-[12px] leading-[18px] font-medium">{name}</strong>
        )}
        <span className="sidebar-item-detail item-detail flex h-6 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] leading-[18px] [.sidebar-item:has(.sidebar-item-actions)_&]:pr-[var(--_sidebar-actions-space,52px)]">
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
