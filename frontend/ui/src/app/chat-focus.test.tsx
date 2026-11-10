import { render, type Rendered } from "@novadeck/test-kit/render"
import { useRef } from "react"

import { describe, expect, it } from "../test"
import { useChatTakesFocus } from "./chat-focus"

// A terminal's host as WorkspaceTerminal draws it: the chat's pane over the screen, which goes
// inert beneath it.
const Host = ({ shown, selected }: { shown: boolean; selected: boolean }): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null)
  useChatTakesFocus(host, shown, selected)
  return (
    <div ref={host}>
      {shown && (
        <div className="chat-pane">
          <textarea className="chat-input" aria-label="box" />
        </div>
      )}
      <div inert={shown}>
        <textarea aria-label="screen" />
      </div>
    </div>
  )
}

const host = (shown: boolean, selected = true) => {
  const page: Rendered = render(<Host shown={shown} selected={selected} />)
  return {
    show: (next: boolean, nextSelected = selected) =>
      page.rerender(<Host shown={next} selected={nextSelected} />),
    field: (name: string) => page.container.querySelector<HTMLElement>(`[aria-label="${name}"]`)!,
  }
}

describe("A terminal's chat coming over its screen", () => {
  it("takes the focus the screen had into its box", () => {
    const page = host(false)
    page.field("screen").focus()
    page.show(true)
    expect(document.activeElement).toBe(page.field("box"))
  })

  it("leaves focus that is elsewhere, as in another terminal", () => {
    const elsewhere = document.createElement("input")
    document.body.append(elsewhere)
    try {
      const page = host(false)
      elsewhere.focus()
      page.show(true)
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it("takes focus the screen dropped only in the selected terminal", () => {
    const page = host(false, false)
    page.show(true)
    expect(document.activeElement).toBe(document.body)
    page.show(false, true)
    page.show(true, true)
    expect(document.activeElement).toBe(page.field("box"))
  })

  it("leaves focus alone for a chat there from the start", () => {
    host(true)
    expect(document.activeElement).toBe(document.body)
  })
})
