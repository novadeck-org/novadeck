import { OutlineThumb } from "../../document/OutlineThumb"
import type { ItemProps } from "../../registration"
import { usePlan } from "../../store/use-item-store"

// The plan: its title over its sections, its name until it loads.
export const PlanThumb = ({ item, itemStore }: ItemProps): React.JSX.Element => {
  const plan = usePlan(itemStore, item.id)
  return <OutlineThumb path={item.name} text={plan?.text ?? ""} />
}
