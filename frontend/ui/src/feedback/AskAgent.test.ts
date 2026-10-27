import type { Feedback } from "@novadeck/core/feedback"
import type { TerminalKey } from "@novadeck/core/types"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { askAgentStore, closeAskAgent, openAskAgent } from "./ask-agent-state"
import { AskAgent } from "./AskAgent"

Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }

const mount = (ask: Feedback["ask"] = () => Promise.resolve()) => {
  const asked: { key: TerminalKey; hint: string }[] = []
  const feedback: Feedback = {
    about: () => Promise.resolve({ version: "0.0.1", os: "Linux x64" }),
    send: () => Promise.resolve(),
    ask: (terminal, hint) => {
      asked.push({ key: terminal, hint })
      return ask(terminal, hint)
    },
  }
  const view = render(createElement(AskAgent, { feedback }))
  return { view, asked }
}

const card = () => document.querySelector(".ask-agent-card")
const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".ask-agent-card button")).find(
    (each) => each.textContent?.trim() === name,
  )!

// The terminal's input, where focus returns to when the card closes.
const terminal = () => {
  const area = document.createElement("div")
  area.setAttribute("data-workspace-area", "")
  area.innerHTML = '<div data-terminal="t1"><input data-terminal-input></div>'
  document.body.append(area)
  return { input: area.querySelector("input")!, remove: () => area.remove() }
}

afterEach(() => closeAskAgent())

describe("The card that asks an agent for feedback", () => {
  it("is closed until a window's menu opens it for an agent", async () => {
    const { view } = mount()
    expect(card()).toBeNull()
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    expect(card()?.querySelector("h2")?.textContent).toBe("Ask @moth to write feedback")
    expect(card()?.querySelector(".handle-chip")?.textContent).toBe("@moth")
    expect(card()?.textContent).toContain(
      "It writes it up from what it just did here and decides whether it's a bug, an idea or something else.",
    )
    expect(card()?.textContent).toContain("The draft opens in the feedback card.")
    expect(card()?.querySelector("textarea")?.placeholder).toBe(
      "Anything it should cover? (optional)",
    )
    view.unmount()
  })

  it("caps the hint at the note's limit, as the contract does", async () => {
    const { view } = mount()
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    expect(card()?.querySelector("textarea")?.maxLength).toBe(2000)
    view.unmount()
  })

  it("asks that terminal with the hint, then closes", async () => {
    const { view, asked } = mount()
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    const field = card()!.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "  the toast  ",
      )
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => button("Ask").click())
    expect(asked).toEqual([{ key, hint: "the toast" }])
    expect(askAgentStore.getSnapshot()).toBeNull()
    await nextFrame()
    view.unmount()
  })

  it("stays open and says so when no agent runs there", async () => {
    const { view } = mount(() => Promise.reject(new Error("no agent")))
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    await act(async () => button("Ask").click())
    expect(card()?.querySelector("[role=alert]")?.textContent).toBe(
      "Couldn't ask: no agent is running there.",
    )
    expect(button("Ask").disabled).toBe(false)
    view.unmount()
  })

  it("leaves a card opened for another window when an earlier ask answers late", async () => {
    let answer = (): void => {}
    const { view } = mount(() => new Promise<void>((resolve) => void (answer = resolve)))
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    await act(async () => button("Ask").click())
    const other = { key: { ...key, terminalId: "t2" }, handle: "fox" }
    act(() => openAskAgent(other))
    await act(async () => answer())
    expect(askAgentStore.getSnapshot()).toBe(other)
    view.unmount()
  })

  it("closes when the app goes", async () => {
    const { view } = mount()
    act(() => openAskAgent({ key, handle: "moth" }))
    view.unmount()
    expect(askAgentStore.getSnapshot()).toBeNull()
  })

  it("closes with its close button, keeping nothing asked", async () => {
    const { view, asked } = mount()
    act(() => openAskAgent({ key, handle: "moth" }))
    await nextFrame()
    act(() => card()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(askAgentStore.getSnapshot()).toBeNull()
    expect(asked).toEqual([])
    await nextFrame()
    view.unmount()
  })

  it("returns focus to the terminal however it closes", async () => {
    const { input, remove } = terminal()
    const { view } = mount()
    const open = async () => {
      act(() => openAskAgent({ key, handle: "moth" }))
      await nextFrame()
      expect(document.activeElement).not.toBe(input)
    }
    await open()
    act(() => card()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(document.activeElement).toBe(input)
    input.blur()
    await open()
    act(() => {
      card()!
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    await nextFrame()
    expect(document.activeElement).toBe(input)
    input.blur()
    await open()
    await act(async () => button("Ask").click())
    expect(document.activeElement).toBe(input)
    view.unmount()
    remove()
  })
})
