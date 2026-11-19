import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { addressOf } from "@novadeck/viewers/browser"
import { useLayoutEffect, useRef, useState } from "react"

// Where a page is, as a chip at the start of its pane's tools, which the person edits to go
// elsewhere: focused, it holds the whole address, selected, to type over; Enter goes where it
// says, an http(s) address only (`addressOf`: none typed is tried over https, or http for this
// machine), and Escape puts it back as it was. Leaving it does too. A field, so its keys are
// its own while it has focus: the terminal under a covering pane and the app's own keys let
// them be (cover-keys.ts). Enter hands focus on to the page it loads; Escape, and an address
// opened in the browser, back to where it came from, or else to the page.

// An address as the chip shows it at rest: no scheme, and no lone slash after its host.
export const shortAddress = (url: string): string =>
  url.replace(/^https?:\/\//i, "").replace(/^([^/?#]*)\/$/, "$1")

export const AddressField = ({
  where,
  live,
  onGo,
  onReturn,
}: {
  // Where the page is now.
  where: string
  // Whether the page goes there itself; elsewhere the address opens in the browser.
  live: boolean
  // Goes to an address the person typed, which `addressOf` has made an http(s) one.
  onGo: (url: string) => void
  // Where focus goes when there's nowhere it came from: the page.
  onReturn: () => void
}): React.JSX.Element => {
  const field = useRef<HTMLInputElement>(null)
  // What the person is typing, while they are.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [invalid, setInvalid] = useState(false)
  // What had focus before the field, to give it back to.
  const from = useRef<HTMLElement | null>(null)
  // A press that focused the field: its release would drop the selection to a caret.
  const pressed = useRef(false)
  const editing = draft !== undefined
  useLayoutEffect(() => {
    if (editing) field.current?.select()
  }, [editing])
  const giveBack = (): void => {
    const back = from.current
    from.current = null
    if (back?.isConnected && back !== field.current) back.focus({ preventScroll: true })
    else onReturn()
  }
  const go = (): void => {
    const url = addressOf(draft ?? "")
    if (url === undefined) {
      setInvalid(true)
      return
    }
    setDraft(undefined)
    setInvalid(false)
    onGo(url)
    // Gone there, the person is at the page; opened in the browser, back where they were.
    if (live) {
      from.current = null
      onReturn()
    } else giveBack()
  }
  return (
    <Tooltip content={where} disabled={editing}>
      <input
        ref={field}
        type="text"
        className="page-address"
        inputMode="url"
        enterKeyHint="go"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Address"
        aria-description={live ? undefined : "Opens in your browser"}
        aria-invalid={invalid || undefined}
        placeholder="Type an address"
        value={draft ?? shortAddress(where)}
        data-editing={editing || undefined}
        onPointerDown={() => {
          if (!editing) pressed.current = true
        }}
        onMouseUp={(event) => {
          if (!pressed.current) return
          pressed.current = false
          event.preventDefault()
        }}
        onFocus={(event) => {
          from.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
          setDraft(where)
          setInvalid(false)
        }}
        onBlur={() => {
          pressed.current = false
          setDraft(undefined)
          setInvalid(false)
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          setInvalid(false)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter") {
            event.preventDefault()
            go()
          } else if (event.key === "Escape") {
            // The field's own: not the pane's, which would hide.
            event.preventDefault()
            event.stopPropagation()
            setDraft(undefined)
            setInvalid(false)
            giveBack()
          }
        }}
      />
    </Tooltip>
  )
}
