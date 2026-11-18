// What a pane does for a key pressed where its own keys can't be heard, as in the PDF
// viewer's frame: named actions, never keys, so nothing typed there reaches a terminal or an
// agent's composer. The viewer raises one on its element, and the pane that holds it, which
// alone listens, carries it out.

export type PaneAction = "hide" | "next-tab" | "previous-tab"

const event = "novadeck:pane-action"

/** Raises `action` from `element`, for the pane that holds it. */
export const raisePaneAction = (element: Element, action: PaneAction): void => {
  element.dispatchEvent(new CustomEvent<PaneAction>(event, { bubbles: true, detail: action }))
}

/** Hears the actions raised inside `element`; the returned function stops. */
export const onPaneAction = (element: Element, act: (action: PaneAction) => void): (() => void) => {
  const listener = (raised: Event): void => {
    const { detail } = raised as CustomEvent<unknown>
    if (detail !== "hide" && detail !== "next-tab" && detail !== "previous-tab") return
    raised.stopPropagation()
    act(detail)
  }
  element.addEventListener(event, listener)
  return () => element.removeEventListener(event, listener)
}
