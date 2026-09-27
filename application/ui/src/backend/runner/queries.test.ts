import { Terminal } from "@xterm/xterm"
import { vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { silenceQueries } from "./queries"

// jsdom has no canvas or media queries; xterm parses without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

const queries = [
  "\u001b[c", // DA1
  "\u001b[>c", // DA2
  "\u001b[=c", // DA3
  "\u001b[5n", // status
  "\u001b[6n", // cursor position
  "\u001b[?6n", // DEC cursor position
  "\u001b[4$p", // ANSI mode
  "\u001b[?25$p", // DEC mode
  "\u001bP$qm\u001b\\", // DECRQSS
  "\u001b[>q", // XTVERSION
  "\u001b[14t", // window size in pixels
  "\u001b[18t", // text area size
]

// What a terminal sends back after being written `data`.
const replies = async (data: string, silenced: boolean): Promise<string[]> => {
  const xterm = new Terminal({ allowProposedApi: false })
  const element = document.createElement("div")
  document.body.append(element)
  xterm.open(element)
  if (silenced) silenceQueries(xterm)
  const sent: string[] = []
  xterm.onData((reply) => sent.push(reply))
  await new Promise<void>((resolve) => xterm.write(data, resolve))
  const text = xterm.buffer.active.getLine(0)?.translateToString(true) ?? ""
  xterm.dispose()
  element.remove()
  return [...sent, `screen:${text}`]
}

describe("silenced terminal queries", () => {
  context("without silencing", () => {
    it("xterm answers queries itself", async () => {
      expect((await replies("\u001b[c\u001b[6n", false)).length).toBeGreaterThan(1)
    })
  })

  context("with silencing", () => {
    it("answers none of the queries the runner answers", async () => {
      expect(await replies(queries.join(""), true)).toEqual(["screen:"])
    })

    it("still answers colour queries, which the runner leaves unanswered", async () => {
      const sent = await replies("\u001b]11;?\u0007", true)
      expect(sent.some((reply) => reply.startsWith("\u001b]11;rgb:"))).toBe(true)
    })

    it("still draws ordinary output", async () => {
      expect(await replies("\u001b[31mred\u001b[0m \u001b]11;#000000\u0007ok", true)).toEqual([
        "screen:red ok",
      ])
    })
  })
})
