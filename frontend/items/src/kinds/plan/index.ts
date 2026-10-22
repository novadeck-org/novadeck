import { FileStack, FileText } from "lucide-react"

import type { ItemMember } from "../../bar"
import type { PaneRegistration } from "../../registration"
import { titleOf } from "./plan-text"
import { PlanView } from "./PlanTab"
import { PlanThumb } from "./PlanThumb"

// A plan an agent wrote, edited where it's read. A subagent's plan has an icon of its own.
// Its name is its title once it loads.
export const plan = {
  kind: "plan",
  names: { one: "plan", many: "Plans" },
  icon: ({ item }: { readonly item: { readonly plan: { readonly role: string } | null } }) =>
    item.plan?.role === "subagent" ? FileStack : FileText,
  stackIcon: FileText,
  look: ({ item }, { plans }) => {
    const title = titleOf(item.name, plans[item.id]?.text ?? "")
    return {
      name: title,
      label: `${item.plan?.role === "subagent" ? "Subagent plan" : "Plan"}: ${title}`,
    }
  },
  Thumb: PlanThumb,
  View: PlanView,
  // In a window of its own it reads inside the same frame as in the pane.
  windowLabel: "Plan",
} satisfies PaneRegistration<ItemMember, "plan">
