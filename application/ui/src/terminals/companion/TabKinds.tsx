import { slotIcon } from "./artifact-icons"
import { isNew, type BarSlot } from "./bar"

// What a terminal's companion bar holds, on its sidebar tab's name line: an icon for each
// icon on the bar, in the bar's order. What's been seen is faint; something not yet
// opened, and the messages while some wait for the agent, is a step brighter with a small
// dot. How many, and whether they're held or paused, the tab's description says in words.
export const TabKinds = ({
  slots,
  mail,
}: {
  slots: readonly BarSlot[]
  // Whether messages wait for the agent.
  mail: boolean
}): React.JSX.Element => (
  <span aria-hidden className="terminal-tab-kinds">
    {slots.map((slot) => {
      const Icon = slotIcon(slot)
      const messages = !slot.stack && slot.members[0]!.kind === "messages"
      const fresh = messages ? mail : slot.members.some(isNew)
      return (
        <span key={slot.key} className="terminal-tab-kind" data-state={fresh ? "new" : "seen"}>
          <Icon size={12} strokeWidth={1.75} />
        </span>
      )
    })}
  </span>
)
