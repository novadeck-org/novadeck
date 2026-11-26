import { Portal } from "@ark-ui/react/portal"
import { Select as ArkSelect, createListCollection } from "@ark-ui/react/select"
import { Check, ChevronDown } from "lucide-react"
import { useId, useMemo, type RefObject } from "react"

import { cn } from "./class-name"

export type SelectOption = {
  readonly label: string
  readonly value: string
  readonly description?: string
}

export type SelectProps = {
  readonly label: string
  readonly variant?: "field" | "icon"
  readonly items: readonly SelectOption[]
  readonly value: string
  // Shown while no item is the value.
  readonly placeholder?: string
  readonly onValueChange?: (value: string) => void
  readonly disabled?: boolean
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly portalContainer?: RefObject<HTMLElement | null>
  readonly className?: string
  // What the choice does, under the label, read with the trigger; its look is the caller's.
  readonly description?: string
  readonly descriptionClassName?: string
}

export const Select = ({
  label,
  variant = "field",
  items,
  value,
  placeholder,
  onValueChange,
  disabled,
  open,
  onOpenChange,
  portalContainer,
  className,
  description,
  descriptionClassName,
}: SelectProps): React.JSX.Element => {
  const collection = useMemo(() => createListCollection({ items }), [items])
  const descriptionId = useId()
  const labelPart = (
    <ArkSelect.Label className={variant === "icon" ? "sr-only" : undefined}>
      {label}
    </ArkSelect.Label>
  )
  return (
    <ArkSelect.Root
      className={cn("flex min-w-0 items-center justify-between gap-4 text-body", className)}
      collection={collection}
      value={[value]}
      disabled={disabled}
      onValueChange={(details) => {
        if (details.value[0] !== undefined) onValueChange?.(details.value[0])
      }}
      open={open}
      onOpenChange={(details) => onOpenChange?.(details.open)}
      positioning={{
        placement: variant === "icon" ? "bottom-start" : "bottom-end",
        sameWidth: variant !== "icon",
        gutter: 4,
        strategy: "fixed",
        overflowPadding: 12,
      }}
      lazyMount
      unmountOnExit
    >
      {description === undefined ? (
        labelPart
      ) : (
        <span className="flex min-w-0 flex-col gap-1">
          {labelPart}
          <span id={descriptionId} className={descriptionClassName}>
            {description}
          </span>
        </span>
      )}
      {/* Beside a description, the trigger keeps its width and the words wrap. */}
      <ArkSelect.Control className={description === undefined ? "min-w-0" : "min-w-0 shrink-0"}>
        <ArkSelect.Trigger
          {...(description !== undefined && { "aria-describedby": descriptionId })}
          className={
            variant === "icon"
              ? "icon-button"
              : "field flex min-h-8 min-w-30 items-center justify-between gap-4 px-2.5 py-1.75 text-control"
          }
        >
          <ArkSelect.ValueText
            className={variant === "icon" ? "sr-only" : "truncate"}
            placeholder={placeholder}
          />
          <ArkSelect.Indicator className="field-indicator">
            <ChevronDown size={12} aria-hidden="true" />
          </ArkSelect.Indicator>
        </ArkSelect.Trigger>
      </ArkSelect.Control>
      {/* Modal callers supply their top-layer container; otherwise portal to the document body. */}
      <Portal container={portalContainer}>
        <ArkSelect.Positioner className="z-50">
          <ArkSelect.Content
            className={cn(
              "floating z-50 max-h-[min(240px,var(--available-height))] overflow-y-auto p-1 text-control",
              variant === "icon" && "min-w-48 max-w-[calc(100vw-24px)]",
            )}
          >
            {collection.items.map((item) => (
              <ArkSelect.Item
                key={item.value}
                item={item}
                className="item flex min-h-8 cursor-pointer items-center justify-between gap-3 px-2 py-1.5"
              >
                <ArkSelect.ItemText className="min-w-0 truncate">{item.label}</ArkSelect.ItemText>
                {item.description && (
                  <span className="item-detail ml-auto shrink-0 text-caption">
                    {item.description}
                  </span>
                )}
                <ArkSelect.ItemIndicator>
                  <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                </ArkSelect.ItemIndicator>
              </ArkSelect.Item>
            ))}
          </ArkSelect.Content>
        </ArkSelect.Positioner>
      </Portal>
      <ArkSelect.HiddenSelect />
    </ArkSelect.Root>
  )
}
