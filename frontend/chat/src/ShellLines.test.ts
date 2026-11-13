import type { AgentShell } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { ShellLines, listedShells, type ShellTailsSource } from "./ShellLines"
import { describe, expect, it } from "./test"

const shell = (id: string, exit: AgentShell["exit"] = null): AgentShell => ({
  id,
  command: `cmd ${id}`,
  since: Date.now() - 60_000,
  exit,
})

describe("listedShells", () => {
  it("keeps the running and the failed, not those that ended quietly or stopped", () => {
    const all = [
      shell("run"),
      shell("bad", { at: 1, code: 1 }),
      shell("ok", { at: 1, code: 0 }),
      shell("stop", { at: 1, code: null }),
    ]
    expect(listedShells(all).map(({ id }) => id)).toEqual(["run", "bad"])
    expect(listedShells(undefined)).toEqual([])
  })
})

// Last lines that can move, and a count of how many times they are followed.
const sourceOf = (first: Record<string, string>) => {
  let tails: Readonly<Record<string, string>> = first
  const listeners = new Set<() => void>()
  const followed = { now: 0 }
  const source: ShellTailsSource = {
    watch: () => {
      followed.now += 1
      return () => {
        followed.now -= 1
      }
    },
    subscribe: (on) => {
      listeners.add(on)
      return () => listeners.delete(on)
    },
    snapshot: () => tails,
  }
  return {
    source,
    followed,
    move: (next: Record<string, string>) => {
      tails = next
      listeners.forEach((on) => on())
    },
  }
}

describe("ShellLines", () => {
  const draw = async (onShell?: (id: string) => void) => {
    const shells = [
      { ...shell("run"), output: "/tmp/run.log" },
      { ...shell("bad", { at: 1, code: 1 }), output: "/tmp/bad.log" },
    ]
    return render(
      createElement(ShellLines, {
        shells,
        tails: sourceOf({ run: "listening on 5173", bad: "port is already allocated" }).source,
        onShell,
        open: false,
        onOpen: () => {},
      }),
    )
  }

  it("shows the last line of each shell's output under it, red once it failed, with how it exited", async () => {
    const { container } = await draw()
    const last = [...container.querySelectorAll<HTMLElement>(".chat-shell-last")]
    expect(last.map((each) => [each.textContent, each.dataset.tone])).toEqual([
      ["listening on 5173", undefined],
      ["port is already allocated", "bad"],
    ])
    expect(container.textContent).toContain("exited 1")
  })

  it("opens a shell's output from its line where the app can show it", async () => {
    const opened: string[] = []
    const { container } = await draw((id) => opened.push(id))
    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>("button.chat-shell-command")[1]!.click(),
    )
    await act(async () => container.querySelector<HTMLElement>(".chat-shell-last")!.click())
    expect(opened).toEqual(["bad", "run"])
  })

  it("leaves the lines to stand alone without that", async () => {
    const { container } = await draw()
    expect(container.querySelector("button.chat-shell-command")).toBeNull()
  })

  it("names how a failed shell exited on its button, which the line's fact does not say aloud", async () => {
    const { container } = await draw((id) => id)
    const buttons = [...container.querySelectorAll("button.chat-shell-command")]
    expect(buttons.map((each) => each.getAttribute("aria-label"))).toEqual([
      "Show the output of cmd run",
      "Show the output of cmd bad, exited 1",
    ])
  })

  it("follows the output only while a listed shell has a file, and shows a last line as it moves", async () => {
    const { source, followed, move } = sourceOf({})
    const withFile = [{ ...shell("run"), output: "/tmp/run.log" }]
    const props = (shells: AgentShell[]) => ({
      shells,
      tails: source,
      onShell: undefined,
      open: false,
      onOpen: () => {},
    })
    const { container, rerender } = await render(createElement(ShellLines, props([shell("run")])))
    expect(followed.now).toBe(0)
    await rerender(createElement(ShellLines, props(withFile)))
    expect(followed.now).toBe(1)
    expect(container.querySelector(".chat-shell-last")).toBeNull()
    await act(async () => move({ run: "ready" }))
    expect(container.querySelector(".chat-shell-last")!.textContent).toBe("ready")
  })
})
