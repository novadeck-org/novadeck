import type { MessagesMember } from "../../bar"
import type { ViewProps } from "../../registration"
import { MessagesView } from "./MessagesView"

// The messages registration's body.
export const MessagesPane = ({
  mail,
  peerName,
  actions,
}: ViewProps<MessagesMember>): React.JSX.Element => (
  <MessagesView mail={mail} peerName={peerName} actions={actions} />
)
