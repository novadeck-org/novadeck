import { Menu as ArkMenu } from "@ark-ui/react/menu"
import { Portal } from "@ark-ui/react/portal"
import { useId, type ReactElement, type ReactNode } from "react"

export type ContextMenuItem = {
  value: string
  label: string
  icon?: ReactNode
  onSelect: () => void
}

export type ContextMenuProps = {
  label: string
  trigger: ReactElement
  items: ContextMenuItem[]
}

export const ContextMenu = ({ label, trigger, items }: ContextMenuProps): React.JSX.Element => {
  const labelId = useId()
  return (
    <ArkMenu.Root positioning={{ strategy: "fixed", overflowPadding: 12 }} immediate>
      <ArkMenu.ContextTrigger asChild>{trigger}</ArkMenu.ContextTrigger>
      <Portal>
        <ArkMenu.Positioner className="context-menu-positioner z-50!">
          <ArkMenu.Content
            aria-labelledby={labelId}
            className="min-w-40 rounded-popover border border-line bg-paper p-1 text-[11px] text-ink shadow-floating focus-visible:outline-none"
          >
            <span id={labelId} className="sr-only">
              {label}
            </span>
            {items.map((item) => (
              <ArkMenu.Item
                key={item.value}
                value={item.value}
                onSelect={item.onSelect}
                className="flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 outline-none data-highlighted:bg-shell"
              >
                {item.icon}
                <ArkMenu.ItemText>{item.label}</ArkMenu.ItemText>
              </ArkMenu.Item>
            ))}
          </ArkMenu.Content>
        </ArkMenu.Positioner>
      </Portal>
    </ArkMenu.Root>
  )
}
