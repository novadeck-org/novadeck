import { commonMessage, record, type CommonMessage } from "../frame/messages.js"

// What a web page's frame may tell the app: only what every viewer's frame says (started,
// working, a key's pane action), each checked, and nothing of the page itself.
export type HtmlFrameMessage = CommonMessage

/** A message from the frame, if it is one of these shapes exactly; undefined otherwise. */
export const htmlMessage = (data: unknown): HtmlFrameMessage | undefined => {
  const message = record(data)
  return message ? commonMessage(message) : undefined
}
