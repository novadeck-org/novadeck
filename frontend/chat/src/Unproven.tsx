import type { ChatSlice } from "@novadeck/core/conversation"
import type { Unproven as Reason } from "@novadeck/core/conversation/emptiness"

import { LiveSlice } from "./Slice"

// What the chat says when nothing shows and nothing proves the conversation empty, by why.
const words: Record<Reason, (agent: string) => string> = {
  lost: (agent) =>
    `The conversation isn't showing here: Novadeck can't find or read ${agent}'s transcript of it.`,
  unread: (agent) =>
    `The conversation isn't showing here: ${agent}'s transcript holds records Novadeck couldn't read.`,
  turned: (agent) =>
    `The conversation isn't showing here: ${agent} has worked in this session, but its transcript gave nothing.`,
  screen: (agent) =>
    `Nothing shows here yet, and something of ${agent}'s own may be on its screen.`,
}

// A conversation with nothing to show that isn't known to be empty: why, the agent's own screen
// as it is drawn (the person can see and, where keys pass, answer there) unless its rows show
// below already, and the terminal.
export const Unproven = ({
  reason,
  agent,
  screen,
  below,
  onShowTerminal,
}: {
  readonly reason: Reason
  readonly agent: string
  readonly screen: ChatSlice | null
  // Whether the agent's own rows show under the log, so not here too.
  readonly below: boolean
  readonly onShowTerminal: () => void
}): React.JSX.Element => (
  <div className="chat-unproven">
    <p className="chat-empty" role="status">
      {words[reason](agent)}
      {below && " Its rows are below."}{" "}
      <button type="button" className="button quiet nodrag nopan" onClick={onShowTerminal}>
        Show terminal
      </button>
    </p>
    {screen && <LiveSlice slice={screen} agent={agent} screen />}
  </div>
)
