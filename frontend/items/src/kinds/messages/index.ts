import { MessagesSquare } from "lucide-react"

import type { MessagesMember } from "../../bar"
import type { PaneRegistration } from "../../registration"
import { MailThumb } from "./MailThumb"
import { MessagesPane } from "./MessagesPane"

// A terminal's messages: a pane and not an item, which never stacks.
export const messages = {
  kind: "messages",
  names: { one: "message", many: "Messages" },
  icon: () => MessagesSquare,
  stackIcon: MessagesSquare,
  look: () => ({ name: "Messages", label: "Messages" }),
  Thumb: MailThumb,
  View: MessagesPane,
} satisfies PaneRegistration<MessagesMember, "messages">
