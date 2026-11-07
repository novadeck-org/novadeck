import type { ToolOutcome } from "@novadeck/core/conversation"
import type { ToolEntry } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "./test"
import { ToolCalls } from "./ToolCalls"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const call = (id: string, title: string, detail = ""): ToolEntry => ({
  id,
  call: id,
  tool: title,
  run: { kind: "run", title, detail },
  input: "{}",
  truncated: false,
  result: { id: `${id}:result`, text: "ok", truncated: false },
  outcome: null,
  scripted: false,
})

// A result whose call is outside the window.
const orphan = (id: string): ToolEntry => ({
  id,
  call: id,
  tool: null,
  run: null,
  input: "",
  truncated: false,
  result: { id: `${id}:result`, text: "ok", truncated: false },
  outcome: null,
  scripted: false,
})

const show = (entries: readonly ToolEntry[], live = false) => {
  const { container, unmount } = render(createElement(ToolCalls, { entries, live }))
  unmounts.push(unmount)
  return container
}

const said = (fields: Partial<ToolOutcome>): ToolOutcome => ({
  failed: false,
  exit: null,
  running: false,
  size: null,
  change: null,
  opening: false,
  ...fields,
})

const opened = async (container: HTMLElement, line = ".chat-tool-summary") => {
  await act(async () => container.querySelector<HTMLElement>(line)!.click())
  return container
}

describe("a run of tool calls", () => {
  context("folded", () => {
    it("names what its calls were, leaving out a result whose call is outside the window", () => {
      for (const entries of [
        [orphan("0"), call("1", "Ran"), call("2", "Read"), call("3", "Edited")],
        [call("1", "Ran"), call("2", "Read"), orphan("0"), call("3", "Edited")],
      ]) {
        const fold = show(entries).querySelector(".chat-tools-fold .chat-tool-said")
        expect(fold?.textContent).toBe(" · ran, read, edited")
      }
    })
  })

  it("shows each control that would reorder a call's detail, as the terminal shows it in order", () => {
    // A right-to-left mark, as right-to-left text holds, stays as it is.
    const container = show([call("1", "Ran", "echo \u202Ehi \u05E9\u200F")])
    expect(container.querySelector(".chat-tool-detail")?.textContent).toBe(
      "echo ⟨U+202E⟩hi \u05E9\u200F",
    )
  })

  context("a line", () => {
    it("reads as the call and what came of it, after a dot", () => {
      const line = show([
        {
          ...call("1", "Read", "server/auth.ts"),
          outcome: said({ size: { count: 6, unit: "line" } }),
        },
      ]).querySelector(".chat-tool-summary")
      expect(line?.textContent).toBe("read server/auth.ts · 6 lines")
    })

    it("sets an edit's counts apart, without a dot", () => {
      const container = show([
        {
          ...call("1", "Edited", "server/auth.ts"),
          outcome: said({ change: { added: 2, removed: 1, lines: [] } }),
        },
      ])
      expect(container.querySelector(".chat-tool-summary")?.textContent).toBe(
        "edited server/auth.ts  +2 −1",
      )
      expect(container.querySelector(".chat-tool-added")?.textContent).toBe("+2")
      expect(container.querySelector(".chat-tool-removed")?.textContent).toBe("−1")
    })

    it("marks a failure, and only then", () => {
      const failed = show([
        { ...call("1", "Ran", "pnpm test"), outcome: said({ failed: true, exit: 1 }) },
      ])
      expect(failed.querySelector(".chat-tool")?.hasAttribute("data-failed")).toBe(true)
      expect(failed.querySelector(".chat-tool-summary")?.textContent).toBe("ran pnpm test · exit 1")
      const fine = show([{ ...call("2", "Ran", "pnpm test"), outcome: said({ exit: 0 }) }])
      expect(fine.querySelector(".chat-tool")?.hasAttribute("data-failed")).toBe(false)
    })

    it("ends in dots while it runs, and says so to a screen reader", () => {
      const line = show([{ ...call("1", "Ran", "pnpm test"), result: null }], true)
      expect(line.querySelector(".chat-tool")?.hasAttribute("data-running")).toBe(true)
      expect(line.querySelector(".chat-tool-summary")?.textContent).toBe(
        "running pnpm test …(running)",
      )
    })

    it("doesn't run once the agent's turn is over", () => {
      const line = show([{ ...call("1", "Ran", "pnpm test"), result: null }], false)
      expect(line.querySelector(".chat-tool-summary")?.textContent).toBe("ran pnpm test")
    })

    it("shows a result whose call is outside the window as a result", () => {
      expect(show([orphan("1")]).querySelector(".chat-tool-title")?.textContent).toBe("result")
    })
  })

  context("opened", () => {
    it("stays closed until clicked, and opens to the output", async () => {
      const container = show([call("1", "Ran", "pnpm test")])
      const line = container.querySelector(".chat-tool-summary")!
      expect(line.getAttribute("aria-expanded")).toBe("false")
      expect(container.querySelector(".chat-tool-body")).toBeNull()
      await opened(container)
      expect(line.getAttribute("aria-expanded")).toBe("true")
      expect(container.querySelector('[aria-label="Result"] pre')?.textContent).toBe("ok")
    })

    it("shows the call's input only where it says more than the line", async () => {
      const same = await opened(
        show([{ ...call("1", "Ran", "pnpm test"), input: '{"command":"pnpm test"}' }]),
      )
      expect(same.querySelector('[aria-label="Call"]')).toBeNull()
      const more = await opened(
        show([{ ...call("2", "Ran", "pnpm test"), input: '{"command":"pnpm test\\npnpm lint"}' }]),
      )
      expect(more.querySelector('[aria-label="Call"] pre')?.textContent).toBe(
        "pnpm test\npnpm lint",
      )
    })

    it("shows what an edit changed in place of what it said, with how many more it counted", async () => {
      const container = await opened(
        show([
          {
            ...call("1", "Edited", "server/auth.ts"),
            input: '{"old_string":"a","new_string":"b"}',
            outcome: said({
              change: {
                added: 2,
                removed: 2,
                lines: [
                  { sign: "-", text: "old", line: 14 },
                  { sign: "+", text: "new", line: 14 },
                  { sign: " ", text: "kept", line: null },
                ],
              },
            }),
          },
        ]),
      )
      expect(container.querySelector('[aria-label="Result"]')).toBeNull()
      // Past the lines carried, what it was given is all there is of the rest.
      expect(container.querySelector('[aria-label="Call"] pre')?.textContent).toContain(
        "old_string",
      )
      const lines = [...container.querySelectorAll('[aria-label="Changes"] .chat-diff')]
      expect(lines.map((line) => line.textContent)).toEqual([
        " 14 - old",
        " 14 + new",
        "      kept",
        "… +2 lines",
      ])
      expect(lines.map((line) => line.getAttribute("data-sign"))).toEqual(["-", "+", " ", null])
    })

    it("keeps what it was given where the line couldn't name the file", async () => {
      const container = await opened(
        show([
          {
            ...call("1", "Edited"),
            input: "cut short",
            outcome: said({
              change: { added: 1, removed: 0, lines: [{ sign: "+", text: "b", line: null }] },
            }),
          },
        ]),
      )
      expect(container.querySelector('[aria-label="Call"] pre')?.textContent).toBe("cut short")
    })

    it("leaves out what it was given where the diff is all of it", async () => {
      const container = await opened(
        show([
          {
            ...call("1", "Edited", "x"),
            input: '{"old_string":"a","new_string":"b"}',
            outcome: said({
              change: {
                added: 1,
                removed: 0,
                lines: [{ sign: "+", text: "b", line: null }],
              },
            }),
          },
        ]),
      )
      expect(container.querySelector('[aria-label^="Call"]')).toBeNull()
    })

    it("says where a call has no result", async () => {
      const idle = await opened(show([{ ...call("1", "Ran", "x"), result: null }]))
      expect(idle.querySelector(".chat-tool-body")?.textContent).toContain("No result recorded.")
      const going = await opened(show([{ ...call("2", "Ran", "x"), result: null }], true))
      expect(going.querySelector(".chat-tool-body")?.textContent).toContain("Running…")
    })

    it("says output was cut short", async () => {
      const container = await opened(
        show([{ ...call("1", "Ran", "x"), result: { id: "r", text: "long", truncated: true } }]),
      )
      expect(container.querySelector(".chat-tool-note")?.textContent).toContain("Shortened here")
    })
  })

  context("with calls made inside a script", () => {
    const script = [
      call("1", "Ran", "node report.mjs"),
      { ...call("2", "Read", "manifest.json"), scripted: true },
      { ...call("3", "Read", "stats.json"), scripted: true },
    ]

    it("counts them on the script's line, closed", () => {
      const container = show(script)
      expect(container.querySelectorAll(".chat-tool")).toHaveLength(1)
      expect(container.querySelector(".chat-tool-summary")?.textContent).toBe(
        "ran node report.mjs · 2 calls",
      )
    })

    it("opens to them under the script's output", async () => {
      const container = await opened(show(script))
      const lines = [...container.querySelectorAll(".chat-tool-body .chat-tool-summary")]
      expect(lines.map((line) => line.textContent)).toEqual([
        "read manifest.json",
        "read stats.json",
      ])
    })

    it("says on the script's line that a call inside it failed", () => {
      const failing = [
        call("1", "Ran", "node report.mjs"),
        {
          ...call("2", "Ran", "pnpm test"),
          scripted: true,
          outcome: said({ failed: true, exit: 3 }),
        },
      ]
      const line = show(failing).querySelector(".chat-tool-summary")
      expect(line?.textContent).toBe("ran node report.mjs · 1 call · 1 failed")
      expect(line?.querySelector(".chat-tool-failed")?.textContent).toBe(" · 1 failed")
    })

    it("keeps a failed script's red to what failed, not its count or the lines under it", async () => {
      const container = await opened(
        show([
          { ...call("1", "Ran", "a"), outcome: said({ failed: true, exit: 1 }) },
          {
            ...call("2", "Read", "b"),
            scripted: true,
            outcome: said({ size: { count: 6, unit: "line" } }),
          },
        ]),
      )
      const failed = [...container.querySelectorAll(".chat-tool-failed")]
      expect(failed.map((each) => each.textContent)).toEqual([" · exit 1"])
    })

    it("folds by the lines that show, not the calls behind them", () => {
      const container = show([
        call("1", "Ran", "a"),
        { ...call("2", "Read", "b"), scripted: true },
        { ...call("3", "Read", "c"), scripted: true },
        { ...call("4", "Read", "d"), scripted: true },
      ])
      expect(container.querySelector(".chat-tools-fold")).toBeNull()
    })
  })

  context("folded", () => {
    const run = ["a", "b", "c", "d"].map((name) => call(name, "Ran", name))

    it("counts its calls in one line, closed until clicked", async () => {
      const container = show(run)
      const fold = container.querySelector(".chat-tools-fold")!
      expect(fold.textContent).toBe("4 tool calls · ran ×4")
      expect(fold.getAttribute("aria-expanded")).toBe("false")
      expect(container.querySelector(".chat-tool")).toBeNull()
      await opened(container, ".chat-tools-fold")
      expect(container.querySelectorAll(".chat-tool")).toHaveLength(4)
    })

    it("says a call in it failed, as closed that would go unseen", () => {
      const failing = { ...run[0]!, outcome: said({ failed: true, exit: 1 }) }
      const fold = show([failing, ...run.slice(1)]).querySelector(".chat-tools-fold")
      expect(fold?.textContent).toBe("4 tool calls · ran ×4 · 1 failed")
    })

    it("has no dot with nothing to name", () => {
      const fold = show(["a", "b", "c", "d"].map(orphan)).querySelector(".chat-tools-fold")
      expect(fold?.textContent).toBe("4 tool calls")
    })

    it("stands open while the agent works on it", () => {
      expect(show(run, true).querySelectorAll(".chat-tool")).toHaveLength(4)
    })
  })
})
