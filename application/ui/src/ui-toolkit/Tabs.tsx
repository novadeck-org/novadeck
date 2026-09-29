import { Tabs as ArkTabs } from "@ark-ui/react/tabs"
import type { ReactNode } from "react"

import { cn } from "../class-name"

type PartProps = { children: ReactNode; className?: string }

export const Tabs = ({
  value,
  onValueChange,
  children,
  className,
}: PartProps & { value: string; onValueChange: (value: string) => void }): React.JSX.Element => (
  <ArkTabs.Root
    value={value}
    onValueChange={(details) => onValueChange(details.value)}
    className={className}
  >
    {children}
  </ArkTabs.Root>
)

// The indicator slides to the selected tab; give it its look with `indicatorClassName`.
export const TabList = ({
  label,
  children,
  className,
  indicatorClassName,
}: PartProps & { label: string; indicatorClassName?: string }): React.JSX.Element => (
  <ArkTabs.List aria-label={label} className={cn("relative", className)}>
    {children}
    {indicatorClassName && (
      <ArkTabs.Indicator
        className={cn(
          "pointer-events-none w-(--width) [--transition-duration:var(--motion-state)] [--transition-timing-function:var(--ease-interface)]",
          indicatorClassName,
        )}
      />
    )}
  </ArkTabs.List>
)

export const Tab = (props: PartProps & { value: string }): React.JSX.Element => (
  <ArkTabs.Trigger {...props} />
)

export const TabPanel = ({
  value,
  preserveHeight = false,
  className,
  ...props
}: PartProps & { value: string; preserveHeight?: boolean }): React.JSX.Element => (
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
