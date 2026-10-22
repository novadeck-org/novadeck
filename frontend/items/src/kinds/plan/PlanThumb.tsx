import { outline } from "@novadeck/viewers/text"

import type { ItemMember } from "../../bar"
import type { ThumbProps } from "../../registration"
import { usePlan } from "../../use-item-store"
import { titleOf } from "./plan-text"

// A document in miniature: its title over its sections. A plan's, and a markdown file's.
export const OutlineThumb = ({ path, text }: { path: string; text: string }): React.JSX.Element => (
  <span className="peek-plan">
    <b>{titleOf(path, text)}</b>
    {outline(text)
      .slice(0, 4)
      .map((heading) => (
        <span key={heading.at}>{heading.text}</span>
      ))}
  </span>
)

// The plan: its title over its sections, its name until it loads.
export const PlanThumb = ({ member, itemStore }: ThumbProps<ItemMember>): React.JSX.Element => {
  const plan = usePlan(itemStore, member.item.id)
  return <OutlineThumb path={member.item.name} text={plan?.text ?? ""} />
}
