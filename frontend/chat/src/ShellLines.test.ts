import type { AgentShell } from "@novadeck/core/types"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { ShellLines, listedShells } from "./ShellLines"
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

describe("ShellLines", () => {
  const draw = async (onShell?: (id: string) => void) => {
    const shells = [shell("run"), shell("bad", { at: 1, code: 1 })]
    return render(
      createElement(ShellLines, {
        shells,
        tails: { run: "listening on 5173", bad: "port is already allocated" },
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
})
