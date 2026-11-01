import { AutoRunNote } from "./AutoRunFix"
import { useInboxContext } from "./InboxProvider"

// Command Prompt's startup script, as one compact line at the top of the Inbox beside the
// grants, so the fix is within reach with no Grant card open: where it needs fixing, what the
// last click came to, and Undo while it is hidden. The words and the confirm are `AutoRunFix`'s.
export const AutoRunSection = (): React.JSX.Element | null => {
  const { autorun } = useInboxContext()
  // Not now is kept: the line stays away until the value changes, and Preferences still offers it.
  if (autorun.state === "none" || autorun.dismissed) return null
  return (
    <section
      className="inbox-grants"
      aria-label="Command Prompt startup output"
      data-autorun={autorun.state}
    >
      <ul className="inbox-grants-list">
        <li className="grant-row">
          <AutoRunNote where="panel" line="Antigravity on this PC needs one fix to use approvals" />
        </li>
      </ul>
    </section>
  )
}
