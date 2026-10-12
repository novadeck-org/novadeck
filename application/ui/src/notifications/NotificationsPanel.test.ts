import { createElement } from "react"

import { describe, expect, it } from "../test"
import { render as mount } from "../test/render"
import type { Notification } from "./notifications"
import { NotificationsPanel } from "./NotificationsPanel"

// The panel with the words murmur writes: no demo has murmur, so rows are given.
const row = (terminalName: string, rest: Partial<Notification>): Notification => ({
  kind: "done",
  context: "p/initial",
  projectId: "p",
  projectName: "docs-site",
  sessionId: "initial",
  sessionName: "Main",
  terminalId: terminalName,
  terminalName,
  status: "Done · reply unread",
  ...rest,
})

// The row the panel renders for it; unmounted at once, as the markup is all that is read.
const render = (item: Notification): HTMLElement => {
  const { container, unmount } = mount(
    createElement(NotificationsPanel, {
      items: [item],
      viewing: null,
      onReveal: () => {},
      onDismiss: () => {},
    }),
  )
  const found = container.querySelector<HTMLElement>("[data-notification]")!
  const copy = found.cloneNode(true) as HTMLElement
  unmount()
  return copy
}

const description = (element: HTMLElement): string | null =>
  element.querySelector(".sidebar-item-select")!.getAttribute("aria-description")

describe("The notification center with murmur's words", () => {
  it("shows a question's or a plan's headline on its row, once", () => {
    const question = render(
      row("Schema", {
        kind: "question",
        status: "Asks which database to use · 2 waiting",
        headline: true,
      }),
    )
    expect(question.querySelectorAll(".notification-headline")).toHaveLength(1)
    expect(question.querySelector(".notification-headline")!.textContent).toBe(
      "Asks which database to use · 2 waiting",
    )
    expect(question.querySelector(".notification-where")!.textContent).toMatch(/^Question · /)
    expect(question.querySelector(".notification-reply")).toBeNull()
  })

  it("shows a finish's gist in place of its reply, keeping the reply for speech", () => {
    const done = render(
      row("Checkout", {
        reply: "Rounded per line. Want me to split it too?",
        gist: "Rounded totals per line",
        asks: true,
      }),
    )
    const gist = done.querySelector(".notification-gist")!
    expect(gist.textContent).toBe("Rounded totals per line")
    expect(gist.querySelector("svg[aria-hidden]")).not.toBeNull()
    expect(done.textContent).not.toContain("Want me to split")
    expect(description(done)).toBe(
      "Done · reply unread. docs-site · Main. Asks you something. Rounded per line. Want me to split it too?",
    )
    // Asking changes nothing of what the row is.
    expect(done.getAttribute("data-notification")).toBe("done")
  })

  it("marks no question on a gist that does not ask", () => {
    const failed = render(
      row("Build", {
        kind: "failed",
        status: "Stopped with an error · reply unread",
        reply: "I could not finish.",
        gist: "Test suite no longer compiles",
      }),
    )
    expect(failed.querySelector(".notification-gist")!.textContent).toBe(
      "Test suite no longer compiles",
    )
    expect(failed.querySelector(".notification-gist svg")).toBeNull()
    expect(description(failed)).not.toContain("Asks you something")
  })

  it("shows the reply line as before where murmur wrote no gist", () => {
    const plain = render(row("Plain", { reply: "All green." }))
    expect(plain.querySelector(".notification-reply")!.textContent).toBe("All green.")
    expect(plain.querySelector(".notification-gist")).toBeNull()
  })
})
