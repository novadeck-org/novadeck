import { Tabs as ArkTabs } from "@ark-ui/react/tabs"
import type { ReactNode } from "react"

import { cn } from "./class-name"

type PartProps = { readonly children: ReactNode; readonly className?: string }

// Tabs side by side by default; `vertical` stacks them, as a menu down a dialog's side, where
// the arrow keys move up and down and the indicator follows each tab's top.
export const Tabs = ({
  value,
  onValueChange,
  orientation = "horizontal",
  children,
  className,
}: PartProps & {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly orientation?: "horizontal" | "vertical"
}): React.JSX.Element => (
  <ArkTabs.Root
    value={value}
    onValueChange={(details) => onValueChange(details.value)}
    orientation={orientation}
    className={className}
  >
    {children}
  </ArkTabs.Root>
)

// The indicator slides to the selected tab, drawn by the segmented recipe;
// `indicatorClassName` places it.
export const TabList = ({
  label,
  children,
  className,
  indicatorClassName,
}: PartProps & {
  readonly label: string
  readonly indicatorClassName?: string
}): React.JSX.Element => (
  <ArkTabs.List aria-label={label} className={cn("relative", className)}>
    {children}
    {indicatorClassName && (
      <ArkTabs.Indicator
        className={cn("tabs-indicator pointer-events-none w-(--width)", indicatorClassName)}
      />
    )}
  </ArkTabs.List>
)

export const Tab = ({
  className,
  ...props
}: PartProps & { readonly value: string }): React.JSX.Element => (
  <ArkTabs.Trigger {...props} className={cn("tab", className)} />
)

export const TabPanel = ({
  value,
  preserveHeight = false,
  className,
  ...props
}: PartProps & {
  readonly value: string
  readonly preserveHeight?: boolean
}): React.JSX.Element => (
  <ArkTabs.Context>
    {(tabs) => (
      <ArkTabs.Content
        {...props}
        value={value}
        // Opt into keeping inactive panels in layout for a stable-height container.
        hidden={!preserveHeight && tabs.value !== value}
        className={cn(
          className,
          preserveHeight && tabs.value !== value && "invisible pointer-events-none",
        )}
        inert={tabs.value !== value}
        aria-hidden={tabs.value !== value}
        tabIndex={tabs.value === value ? 0 : -1}
      />
    )}
  </ArkTabs.Context>
)
