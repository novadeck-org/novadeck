import { ToggleGroup as ArkToggleGroup } from "@ark-ui/react/toggle-group"
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useMemo,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react"

import { Tooltip } from "./Tooltip"

export type ToggleGroupProps = {
  value: string[]
  onValueChange: (value: string[]) => void
  orientation?: "horizontal" | "vertical"
  className?: string
  children: ReactNode
  "aria-label"?: string
}

const ItemId = createContext<(value: string) => string>(() => "")

export const ToggleGroup = ({
  value,
  onValueChange,
  orientation = "horizontal",
  ...props
}: ToggleGroupProps): React.JSX.Element => {
  const id = useId()
  const itemId = useMemo(() => {
    const ids = new Map<string, string>()
    Children.forEach(props.children, (child) => {
      if (isValidElement<ToggleGroupItemProps>(child) && child.props.id) {
        ids.set(child.props.value, child.props.id)
      }
    })
    return (item: string): string => ids.get(item) ?? `${id}:${item}`
  }, [id, props.children])
  return (
    <ItemId.Provider value={itemId}>
      <ArkToggleGroup.Root
        {...props}
        id={id}
        ids={{ item: itemId }}
        multiple={false}
        deselectable
        orientation={orientation}
        value={value}
        onValueChange={(details) => onValueChange(details.value)}
      />
    </ItemId.Provider>
  )
}

export type ToggleGroupItemProps = Omit<ComponentPropsWithRef<"button">, "value"> & {
  value: string
  tooltip?: ReactNode
}

export const ToggleGroupItem = ({
  tooltip,
  value,
  ...props
}: ToggleGroupItemProps): React.JSX.Element => {
  const itemId = useContext(ItemId)
  const item = <ArkToggleGroup.Item {...props} id={itemId(value)} value={value} />
  return tooltip === undefined ? item : <Tooltip content={tooltip}>{item}</Tooltip>
}
