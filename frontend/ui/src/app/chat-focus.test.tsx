import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, useRef } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { boxWaitMs, useChatTakesFocus } from "./chat-focus"

// A terminal's host as WorkspaceTerminal draws it: the chat's pane over the screen, which goes
// inert beneath it.
// `built` false is a chat waiting its turn, with no box yet.
const Host = ({
  shown,
  selected,
  built = true,
}: {
  shown: boolean
  selected: boolean
  built?: boolean
}): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null)
  useChatTakesFocus(host, shown, selected)
  return (
    <div ref={host}>
      {shown && built && (
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
    show: (next: boolean, nextSelected = selected, built = true) =>
      page.rerender(<Host shown={next} selected={nextSelected} built={built} />),
    field: (name: string) => page.container.querySelector<HTMLElement>(`[aria-label="${name}"]`)!,
  }
}

describe("A terminal's chat coming over its screen", () => {
  it("takes focus into its box once built, where it waits its turn", async () => {
    const page = host(false)
    page.field("screen").focus()
    page.show(true, true, false)
    page.show(true, true, true)
    await vi.waitFor(() => expect(document.activeElement).toBe(page.field("box")))
  })

  it("leaves focus be where its box takes too long to come", async () => {
    vi.useFakeTimers()
    try {
      const page = host(false)
      page.field("screen").focus()
      page.show(true, true, false)
      act(() => void vi.advanceTimersByTime(boxWaitMs))
      page.show(true, true, true)
      // What the page's observers hear comes after the render.
      await act(async () => {})
      expect(document.activeElement).not.toBe(page.field("box"))
    } finally {
      vi.useRealTimers()
    }
  })

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
