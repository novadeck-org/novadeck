// Enter sends from a text field; Shift+Enter starts a line, except in a field of the
// agent's own (`single`), which takes one; a modified Enter belongs to the workspace's
// shortcuts.
export const submitOnEnter =
  (submit: () => void, single = false) =>
  (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    if (event.shiftKey) {
      if (single) event.preventDefault()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    submit()
  }
