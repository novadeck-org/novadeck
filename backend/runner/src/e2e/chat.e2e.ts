/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AgentBox, TranscriptItem } from "@novadeck/protocol"
import { isEmpty } from "@novadeck/tui-input/box"

import { harnesses } from "../harnesses/registry.js"
import type { Receipts } from "../terminals/receipts.js"
import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import { occurrences, type DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { losesAstral } from "./known-gaps.js"
import { asked, gate, latest, type Call } from "./model/script.js"
import { lacking, nestedRuns, own, replies, start, through, turn } from "./scenarios.js"

// A 1x1 PNG, for a prompt with an image.
const picture = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

// The chat view's way to an agent, the same for every harness (see messaging.e2e.ts for
// the rule on parity): `agents.prompt` and `agents.interrupt`, read back through
// `agents.transcript` of the root actor `agents.detail` names (docs/backend-api.md).

/** The root transcript's text items of `role`, as `agents.transcript` gives them. */
const texts = async (terminal: DeckTerminal, role: TranscriptItem["role"]): Promise<string[]> =>
  (await terminal.transcript())
    .filter((item) => item.role === role && item.kind === "text")
    .map((item) => item.text)

/** Waits until the transcript holds a `role` item whose text passes `fits`, and returns it. */
const item = (
  terminal: DeckTerminal,
  role: TranscriptItem["role"],
  fits: (text: string) => boolean,
): Promise<string> =>
  terminal.poll(
    async () => {
      // A transcript the agent has not opened yet (or is changing) is NOT_FOUND: wait on.
      try {
        return (await texts(terminal, role)).find(fits)
      } catch (error) {
        if ((error as { code?: string }).code === "NOT_FOUND") return undefined
        throw error
      }
    },
    `its transcript to hold a ${role} item`,
    30_000,
  )

/**
 * Gives the agent a prompt as the chat does, and checks its receipt: followed, pending or
 * already settled once the Enter is out (`agents.detail`); then returns a wait for it to
 * settle, as the user item at its `item` that holds its words.
 */
const prompted = async (terminal: DeckTerminal, text: string): Promise<() => Promise<void>> => {
  // Its first line names it in a failure: a long prompt's whole text would bury the message.
  const [label = ""] = text.split("\n")
  const receiptOf = async (ref: string) =>
    ((await terminal.detail()).prompts ?? []).find((prompt) => prompt.ref === ref)
  const { ref, tracked } = await terminal.prompt(text)
  expect(tracked, `${label}: followed`).toBe(true)
  expect((await receiptOf(ref))?.state, `${label}: its receipt once sent`).toMatch(
    /^(pending|settled)$/,
  )
  return async () => {
    const settled = await terminal.poll(
      async () => {
        const receipt = await receiptOf(ref)
        expect(receipt?.state, `${label}: never missing`).not.toMatch(/^(unrecorded|in-box)$/)
        return receipt?.state === "settled" ? receipt : undefined
      },
      `"${label}" to reach its agent's record`,
      30_000,
    )
    const items = await terminal.transcript()
    const at = items.find((each) => each.index === settled.item)
    expect(at?.role, `${label}: settled by`).toBe("user")
    expect(at?.text, `${label}: settled by`).toContain(label)
  }
}

/**
 * What the record holds of a message sent along with text in the box: a blank line between,
 * and a space where a paste is keys, whose line break would be an Enter.
 */
const along = (setup: AgentSetup, box: string, message: string): string =>
  `${box}${harnesses[setup.agent].box.pastesAsKeys?.() ? " " : "\n\n"}${message}`

/**
 * What a client that keeps reading the terminal's `agents.detail` sees of its box, as only
 * those are followed. `shows` waits until the box fits, and gives what it holds.
 */
const following = (run: E2E, terminal: DeckTerminal) => {
  const controller = new AbortController()
  const stream = run.deck.terminals.detail(terminal.id, controller.signal)
  let latestBox: AgentBox | null = null
  void (async () => {
    for await (const detail of stream) latestBox = detail.box ?? null
  })().catch(() => undefined)
  return {
    shows: async (fits: (box: AgentBox | null) => boolean): Promise<AgentBox | null> => {
      await terminal.poll(() => fits(latestBox) || undefined, "its box to show that")
      return latestBox
    },
    now: () => latestBox,
    stop: () => controller.abort(),
  }
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("gives its agent a one-line prompt, which the transcript shows with the reply", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Greet the chat", "Hello, chat."))
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.prompt("Greet the chat")
      await t1.until("Hello, chat.")
      await through(t1, ["working", "settled"], { after: mark })

      expect(await item(t1, "user", (text) => text.includes("Greet the chat"))).toContain(
        "Greet the chat",
      )
      await item(t1, "assistant", (text) => text.includes("Hello, chat."))
    })

    it("names the terminal by no prompt: given by the chat or typed, it keeps its default title", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Greet the chat", "Hello, chat."))
      const chat = await start(run, setup)
      const typed = await start(run, setup)

      await chat.prompt("Greet the chat")
      await chat.until("Hello, chat.")
      await turn(typed, "Greet the chat", "Hello, chat.")

      // Only murmur, which is off here, a person, an opening agent or the agent itself (through
      // `describe`, which this model never calls) titles a terminal.
      for (const { titleSource } of [chat.summary(), typed.summary()])
        expect(titleSource).toEqual({ kind: "default" })
    })

    it("holds a compaction between turns, with its summary", async ({ e2e: run }) => {
      run.model.use(() => ({ text: "Noted." }))
      const t1 = await start(run, setup)
      const first = t1.mark()
      await t1.submit("First words")
      await t1.until("Noted.")
      // Its turn over first: Codex turns a command away while one runs (Windows CI).
      await through(t1, ["working", "settled"], { after: first })
      await t1.submit("/compact")
      const compacted = await t1.poll(
        async () => (await t1.transcript()).find((each) => each.note?.type === "compaction"),
        "a compaction in its transcript",
        30_000,
      )
      expect(compacted.role).toBe("note")
      expect(compacted.text).not.toBe("")
    })

    it("says its mode between turns, the change showing in what it records", async ({
      e2e: run,
    }) => {
      run.model.use(() => ({ text: "Noted." }))
      const t1 = await start(run, setup)
      const first = t1.mark()
      await t1.submit("First words")
      await t1.until("Noted.")
      // Its turn over first: Codex turns a command away while one runs (Windows CI).
      await through(t1, ["working", "settled"], { after: first })
      const shiftTab = "\x1b[Z"
      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      // Its plan mode, or Claude Code's accept-edits, the first Shift+Tab takes it to.
      if (setup.agent === "codex") await setup.planning!.enter!(t1)
      else {
        write(shiftTab)
        await sleep(1000)
        if (setup.agent === "agy") {
          write(shiftTab)
          await sleep(1000)
        }
      }
      await t1.submit("After the change")
      const said = { claude: "acceptEdits", codex: "plan", agy: "plan" }[setup.agent]
      await t1.poll(
        async () =>
          (await t1.transcript()).some(({ note }) => note?.type === "mode" && note.mode === said) ||
          undefined,
        "its mode in its transcript",
        30_000,
      )
    })

    it("gives its agent a multi-line prompt as one prompt, whole in the transcript", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Third line of the chat", "Got three lines."))
      const t1 = await start(run, setup)
      const mark = t1.mark()
      const lines = ["First line of the chat", "Second line of the chat", "Third line of the chat"]

      const settled = await prompted(t1, lines.join("\n"))
      await t1.until("Got three lines.")
      await through(t1, ["working", "settled"], { after: mark })
      // Its receipt settles on the one user item that holds all three lines.
      await settled()

      const user = await item(t1, "user", (text) => text.includes("Third line of the chat"))
      expect(user.split("\n").map((line) => line.trim())).toEqual(lines)
      await item(t1, "assistant", (text) => text.includes("Got three lines."))
      // One prompt, one user turn: the line breaks never submitted anything.
      expect((await texts(t1, "user")).filter((text) => text.includes("First line"))).toHaveLength(
        1,
      )
    })

    // Where a paste is keys, a line break is an Enter unless it comes in a burst of typing, so
    // what's before the first one may decide if the message goes whole (`pastesWhole`, which
    // guards a message over a draft). Over an empty box, each first line has to get there.
    gated(it, harnesses[setup.agent].box.pastesAsKeys ? undefined : "its paste is never keys")(
      "gives its agent a message in lines over an empty box, whatever its first line's length",
      async ({ e2e: run }) => {
        run.model.use(
          own((call) => (asked(call, "its next line") ? { text: "Got it." } : undefined)),
        )
        const t1 = await start(run, setup)
        for (const length of [1, 3, 8, 12, 15, 16, 24, 60]) {
          const lines = `${"w".repeat(length)}\nits next line of ${length}\nits last`
          const mark = t1.mark()
          // eslint-disable-next-line no-await-in-loop -- Each is a turn of its own.
          const settled = await prompted(t1, lines)
          // eslint-disable-next-line no-await-in-loop -- As above.
          await through(t1, ["working", "settled"], { after: mark })
          // eslint-disable-next-line no-await-in-loop -- As above.
          await settled()
          // eslint-disable-next-line no-await-in-loop -- As above.
          expect(await item(t1, "user", (text) => text.includes(`of ${length}\n`))).toBe(lines)
        }
      },
    )

    it("gives its agent a long prompt that its box may show as a placeholder", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Line 40 of the long prompt", "Read all forty."))
      const t1 = await start(run, setup)
      const mark = t1.mark()
      const lines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the long prompt`)

      // The box may show a placeholder for it, but the record holds the words, and so does
      // its receipt.
      const settled = await prompted(t1, lines.join("\n"))
      await t1.until("Read all forty.")
      await through(t1, ["working", "settled"], { after: mark })
      await settled()

      const user = await item(t1, "user", (text) => text.includes("Line 40 of the long prompt"))
      expect(user.split("\n").map((line) => line.trim())).toEqual(lines)
    })

    it("gives its agent the same message twice, each as its own turn", async ({ e2e: run }) => {
      run.model.use(replies("Say hello", "Hello there."))
      const t1 = await start(run, setup)

      for (const round of [1, 2]) {
        const mark = t1.mark()
        await t1.prompt("Say hello")
        await through(t1, ["working", "settled"], { after: mark })
        await t1.poll(
          async () =>
            (await texts(t1, "assistant")).filter((text) => text.includes("Hello there."))
              .length === round
              ? true
              : undefined,
          `its transcript to hold ${round} replies`,
          30_000,
        )
      }
      expect((await texts(t1, "user")).filter((text) => text === "Say hello")).toHaveLength(2)
    })

    it("gives its agent a short answer that its screen already shows in a reply", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Ask me something", "Answer yes to continue, or no."),
        replies("yes", "Understood, going on."),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.prompt("Ask me something")
      await t1.until("Answer yes to continue, or no.")
      await through(t1, ["working", "settled"], { after: mark })
      const next = t1.mark()
      await t1.prompt("yes")
      await t1.until("Understood, going on.")
      await through(t1, ["working", "settled"], { after: next })

      expect(await item(t1, "user", (text) => text === "yes")).toBe("yes")
    })

    it("sends a message along with a draft in the box, the record holding both", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Shall I go on", "Going on."))
      const t1 = await start(run, setup)
      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      const box = following(run, t1)

      // What the person left, or a failed send: text in the box that no Enter followed.
      write("\x1b[200~Say hello\x1b[201~")
      await t1.until("Say hello")
      // The chat can show it before anything goes with it.
      expect(await box.shows((shown) => shown?.text === "Say hello")).toEqual({
        text: "Say hello",
        mode: "prompt",
        tail: false,
        known: false,
      })

      const mark = t1.mark()
      const settled = await prompted(t1, "Shall I go on")
      await t1.until("Going on.")
      await through(t1, ["working", "settled"], { after: mark })
      await settled()
      expect(await item(t1, "user", (text) => text.includes("Shall I go on"))).toBe(
        along(setup, "Say hello", "Shall I go on"),
      )
      await box.shows((shown) => shown === null)
      box.stop()
    })

    it("follows each of two messages given at once over a draft, the first going along", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Second of two", "Second done."),
        replies("First of two", "First done."),
      )
      const t1 = await start(run, setup)
      t1.press("Half a thought")
      await t1.until("Half a thought")

      const [first, second] = await Promise.all([
        prompted(t1, "First of two"),
        prompted(t1, "Second of two"),
      ])
      await t1.until("Second done.")
      await first()
      await second()
      expect(await item(t1, "user", (text) => text.includes("First of two"))).toContain(
        along(setup, "Half a thought", "First of two"),
      )
    })

    it("puts the cursor after a draft before a message goes along with it", async ({
      e2e: run,
    }) => {
      run.model.use(replies("second word", "Noted."))
      const t1 = await start(run, setup)
      t1.press("first line")
      await t1.until("first line")
      t1.press("\x1b[D\x1b[D\x1b[D")
      await sleep(500)

      await t1.prompt("second word")
      await t1.until("Noted.")
      expect(await item(t1, "user", (text) => text.includes("second word"))).toBe(
        along(setup, "first line", "second word"),
      )
    })

    it("closes a picker a draft holds open, so its Enter sends rather than picks", async ({
      e2e: run,
    }) => {
      writeFileSync(join(run.sandbox.project, "notes.md"), "Notes.\n")
      run.model.use(replies("Look at it", "Looked."))
      const t1 = await start(run, setup)
      t1.press("see @notes")
      await t1.until("see @notes")
      await sleep(1000)

      await t1.prompt("Look at it")
      await t1.until("Looked.")
      expect(await item(t1, "user", (text) => text.includes("Look at it"))).toContain("Look at it")
    })

    it("sends a long message along with a draft, and one over a pasted placeholder", async ({
      e2e: run,
    }) => {
      const lines = Array.from(
        { length: 40 },
        (_, at) => `Line ${at + 1} of a long paste, in words`,
      )
      run.model.use(replies("And this", "Read that."), replies("Line 40", "Read it."))
      const t1 = await start(run, setup)
      t1.press("Before it")
      await t1.until("Before it")
      await t1.prompt(lines.join("\n"))
      await t1.until("Read it.")
      const merged = await item(t1, "user", (text) => text.includes("Line 40"))
      expect(merged.split("\n").map((line) => line.trim())).toEqual(
        along(setup, "Before it", lines.join("\n")).split("\n"),
      )

      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      await sleep(500)
      write(`\x1b[200~${lines.join("\r")}\x1b[201~`)
      await sleep(1500)
      await t1.prompt("And this")
      await t1.until("Read that.")
      const over = await item(t1, "user", (text) => text.includes("And this"))
      expect(over.split("\n").map((line) => line.trim())).toEqual(
        along(setup, lines.join("\n"), "And this").split("\n"),
      )
    })

    it("sends a message along mid-turn, where it goes behind the turn", async ({ e2e: run }) => {
      const held = gate()
      run.model.use(
        // First, as a steered call holds the words of the turn it steers.
        replies("And then", "Then done."),
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()
      await t1.prompt("Hold on")
      await t1.reached("working", { after: mark })
      t1.press("Half a thought")
      await t1.until("Half a thought")

      await t1.prompt("And then")
      held.open()
      await t1.until("Then done.")
      expect(await item(t1, "user", (text) => text.includes("And then"))).toContain(
        "Half a thought",
      )
    })

    it("refuses a message over a command in the box, which it would become the arguments of", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      t1.press("/he")
      await t1.until("/he")

      await expect(t1.prompt("Shall I go on")).rejects.toMatchObject({
        code: "CONFLICT",
        reason: "command",
      })
      await sleep(500)
      expect(await t1.screen()).not.toContain("Shall I go on")
      expect(run.model.calls.slice(calls).filter((call) => !call.side)).toEqual([])
    })

    it("keeps what no one can see the box from out of a draft: the Inbox's lines", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      t1.press("Half a thought")
      await t1.until("Half a thought")

      await expect(
        run.deck.terminals.prompt({ terminalId: t1.id, text: "continue", automatic: true }),
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "draft" })
      await expect(
        run.deck.terminals.prompt({ terminalId: t1.id, text: "my reply" }),
      ).rejects.toMatchObject({ code: "CONFLICT", reason: "draft" })
      await sleep(500)
      const shown = await t1.screen()
      expect(shown).not.toContain("continue")
      expect(shown).not.toContain("my reply")
    })

    it("takes a prompt that came back to the box out of it, handing its words back", async ({
      e2e: run,
    }) => {
      run.model.use(replies("First of all", "First done."), replies("The next one", "Next done."))
      const t1 = await start(run, setup)
      const box = following(run, t1)
      const first = t1.mark()
      await t1.prompt("First of all")
      await t1.until("First done.")
      await through(t1, ["working", "settled"], { after: first })
      // How a prompt gets back there varies by harness, and on a timing no test can hold: its
      // words are in the real box, and the receipts are told as a Stop would tell them.
      run.deck.terminals.write({ terminalId: t1.id, data: "\x1b[200~Queued words\x1b[201~" }, "e2e")
      await t1.until("Queued words")
      const { receipts } = (run.deck.terminals as unknown as { typing: { receipts: Receipts } })
        .typing
      const { ref } = await receipts.expect(t1.id, "Queued words")
      receipts.sent(t1.id, ref)
      await receipts.putBack(t1.id)
      expect(await box.shows((shown) => shown?.known === true)).toEqual({
        text: "Queued words",
        mode: "prompt",
        tail: false,
        known: true,
      })

      const next = t1.mark()
      const { returned } = await t1.prompt("The next one")
      await t1.until("Next done.")
      await through(t1, ["working", "settled"], { after: next })
      expect(returned).toBe("Queued words")
      expect(await item(t1, "user", (text) => text.includes("The next one"))).toBe("The next one")
      const receipt = (await t1.detail()).prompts?.find((each) => each.ref === ref)
      expect(receipt?.state).toBe("withdrawn")
      await box.shows((shown) => shown === null)
      box.stop()
    })

    it("leaves an empty shell mode and sends the message", async ({ e2e: run }) => {
      run.model.use(replies("Out of it", "Out."))
      const t1 = await start(run, setup)
      t1.press("!")
      await t1.poll(
        async () =>
          harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) || undefined,
        "its box in its shell mode",
      )
      const { returned } = await t1.prompt("Out of it")
      await t1.until("Out.")
      expect(returned).toBeNull()
      expect(await item(t1, "user", (text) => text.includes("Out of it"))).toBe("Out of it")
    })

    it("leaves a shell mode holding a command, handing the command back, and runs none of it", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Instead", "Instead then."))
      const t1 = await start(run, setup)
      const left = join(run.sandbox.project, "left.txt")
      t1.press("!")
      await t1.poll(
        async () =>
          harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) || undefined,
        "its box in its shell mode",
      )
      t1.press("echo left > left.txt")
      await t1.until("left.txt")

      const { returned } = await t1.prompt("Instead")
      await t1.until("Instead then.")
      expect(returned).toBe("!echo left > left.txt")
      expect(await item(t1, "user", (text) => text.includes("Instead"))).toBe("Instead")
      expect(existsSync(left)).toBe(false)
    })

    it("refuses a prompt a TUI would read as a command, writing nothing", async ({ e2e: run }) => {
      const t1 = await start(run, setup)

      for (const text of ["/clear", "see @src", "use $", "Hello\x15there", "\x1b[201~x"])
        await expect(t1.prompt(text)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
      await sleep(500)
      const shown = await t1.screenText()
      const box = shown && harnesses[setup.agent].box.read(shown)
      expect(box, JSON.stringify(shown?.rows)).toBeDefined()
      expect(box && isEmpty(box), JSON.stringify(box)).toBe(true)
      expect(await texts(t1, "user")).toEqual([])
    })

    it("gives its agent indented code with a tab, trailing spaces and blank lines, then the next prompt", async ({
      e2e: run,
    }) => {
      run.model.use(replies("def check", "Checked."), replies("Carry on", "Carried on."))
      const t1 = await start(run, setup)
      const mark = t1.mark()

      await t1.prompt("def check():\n\tif x:   \n        return 1  # trailing   \n\n\nend")
      await t1.until("Checked.")
      await through(t1, ["working", "settled"], { after: mark })
      const user = await item(t1, "user", (text) => text.includes("return 1"))
      expect(user.replace(/\s+/g, "")).toBe("defcheck():ifx:return1#trailingend")
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
    })

    it("gives its agent emoji sequences and CJK, then the next prompt", async ({ e2e: run }) => {
      run.model.use(replies("Thanks", "You are welcome."), replies("Carry on", "Carried on."))
      const t1 = await start(run, setup)
      const mark = t1.mark()
      const prompt =
        "Thanks \u2764\ufe0f heart \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family \u65e5\u672c\u8a9e"

      // Known gap (known-gaps.ts, `losesAstral`): in most runs the family's emoji never reach
      // the harness, so the prompt never shows whole and fails, pressing nothing; where they
      // do, it lands as anywhere else.
      if (losesAstral(setup)) {
        const failure = await t1.prompt(prompt).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (failure !== undefined) {
          expect(failure).toMatchObject({ code: "PROMPT_FAILED" })
          // What the paste left stays in the box (probed 2026-10-11, Codex 0.159.3), and the
          // next prompt goes along with it.
          await t1.prompt("Carry on")
          await t1.until("You are welcome.")
          return
        }
      } else await t1.prompt(prompt)
      await t1.until("You are welcome.")
      await through(t1, ["working", "settled"], { after: mark })
      await item(t1, "user", (text) => text.includes("\u65e5\u672c\u8a9e"))
      // What the box drew of it is gone, so the next prompt finds it empty.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
    })

    it("gives its agent prompts back to back, awaited one by one and queued together", async ({
      e2e: run,
    }) => {
      const pairs = [
        { first: "First quick", second: "Second quick", reply: "Did first.", next: "Did second." },
        { first: "Third one", second: "Fourth one", reply: "Did third.", next: "Did fourth." },
        {
          first: "Five\nlines\nof\nit\nhere",
          second: "Then one",
          reply: "Did five.",
          next: "Did then.",
        },
      ].map((pair) => ({ ...pair, held: gate() }))
      run.model.use(
        ...pairs.map((pair) =>
          own(async (call) => {
            if (!asked(call, pair.first)) return undefined
            await pair.held.opened
            // One model call can hold both prompts: a harness that steers gives it the
            // queued one, and Claude Code, when the second reaches it before the first
            // turn's request is built (a loaded machine), sends them as one request
            // (reproduced under CPU load, 2.1.304; both prompts reach the model, none lost).
            // That call answers both, as a person's model would.
            return { text: asked(call, pair.second) ? `${pair.reply} ${pair.next}` : pair.reply }
          }),
        ),
        ...pairs.map((pair) => replies(pair.second, pair.next)),
      )
      const t1 = await start(run, setup)
      const profile = harnesses[setup.agent].box!
      for (const [index, pair] of pairs.entries()) {
        const mark = t1.mark()
        const calls = run.model.mark()
        // Hold the response until the second prompt is actually queued or steered.
        // The CI follow-up reached the harness queue around Stop but never the model;
        // this scenario checks mid-turn queueing, with no race against a model reply.
        if (index === 1) await Promise.all([t1.prompt(pair.first), t1.prompt(pair.second)])
        else {
          await t1.prompt(pair.first)
          await t1.prompt(pair.second)
        }
        await run.model.waitFor((call) => !call.side && asked(call, pair.first), { after: calls })
        await t1.poll(async () => {
          const shown = await t1.screenText()
          const steered = run.model.calls
            .slice(calls)
            .some((call) => !call.side && asked(call, pair.second))
          return steered || (shown && profile.queued(shown)) ? true : undefined
        }, "its second prompt to be queued or steered before the model replies")
        pair.held.open()
        await item(t1, "assistant", (text) => text.includes(pair.next))
        await through(t1, ["working", "settled"], { after: mark })
        await t1.poll(async () => {
          const shown = await t1.screenText()
          const box = shown && profile.read(shown)
          return shown &&
            box &&
            isEmpty(box) &&
            !profile.queued(shown) &&
            t1.history().at(-1)?.delivery === "settled"
            ? true
            : undefined
        }, "its settled prompt to show an empty box and no queued input")
      }

      for (const reply of pairs.flatMap((pair) => [pair.reply, pair.next]))
        await item(t1, "assistant", (text) => text.includes(reply))
      const users = await texts(t1, "user")
      // Each reaches the model once, whether queued, steered or sent with the first.
      for (const pair of pairs)
        expect(
          run.model.calls.filter((call) => !call.side && asked(call, pair.second)),
        ).toHaveLength(1)
      // Each once, as its own prompt; or, where the harness steers, maybe in the turn it
      // joined. A prompt Claude Code takes into a running turn is its queued command, which
      // the transcript shows as the person's own (see harnesses/claude transcripts).
      for (const sent of pairs.flatMap((pair) => [pair.first, pair.second]))
        expect(
          users.filter((text) => (setup.steers ? text.includes(sent) : text === sent)),
        ).toHaveLength(1)
    })

    it("queues a prompt given mid-turn as the person's would be, and answers both", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Start the long job")) return undefined
          await held.opened
          // A harness that steers can give the running turn's call the prompt given mid-turn
          // too, as Codex 0.163 does at once: its one reply answers both.
          return {
            text:
              setup.steers && asked(call, "Then sum it up")
                ? "Long job done. Summed up."
                : "Long job done.",
          }
        }),
        replies("Then sum it up", "Summed up."),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      const first = await prompted(t1, "Start the long job")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Start the long job"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await first()
      const second = await prompted(t1, "Then sum it up\nin one line\n\nthanks")
      held.open()

      await t1.until("Summed up.")
      // The receipt says the record has it, pending until it did.
      await second()
      await through(t1, ["working", "settled"], { after: mark })
      await item(t1, "user", (text) => text.includes("Start the long job"))
      await item(t1, "user", (text) => text.includes("Then sum it up") && text.includes("thanks"))
      await item(t1, "assistant", (text) => text.includes("Long job done."))
      await item(t1, "assistant", (text) => text.includes("Summed up."))
    })

    // Prompts given while the agent's shell tool runs: Claude Code takes them into the turn
    // beside the tool's result (as a `queued_command` attachment, not a user record), Codex
    // steers them into it, and Antigravity holds them for a turn of their own. Whichever,
    // the chat shows each once, as the person's, after the tool's result and before the
    // reply that answers it; prompts that Antigravity merges into one message (`merges`)
    // show as that one message, as its model got them. The tool is a nested run of the
    // harness, held at the fake model until the prompts wait in the harness's queue, so
    // nothing races the tool.
    for (const { what, given, image } of [
      { what: "a prompt", given: ["Also check the logs"] },
      { what: "two prompts", given: ["Also check the logs", "Then tidy up"] },
      // Typed into its box with the image's path pasted after the words, as the chat sends
      // no images.
      { what: "a prompt with an image", given: ["Look at this picture"], image: true },
    ])
      gated(it, image ? lacking(setup, "image") : undefined)(
        `shows ${what} given while a tool runs in the chat, once each, in order, as the person's`,
        async ({ e2e: run }) => {
          const { shell } = setup
          const held = gate()
          const nestedAsk = nestedRuns.whileQueued
          // The nested run's own call: it is asked nothing else.
          const nested = (call: Call) =>
            !call.side &&
            call.turns.some((each) => each.role === "user" && each.text.includes(nestedAsk)) &&
            !call.turns.some((each) => each.role === "user" && each.text.includes("Run the tool"))
          run.model.use(
            own(async (call) => {
              if (!nested(call)) return undefined
              await held.opened
              return { text: "Nested word." }
            }),
            own((call) =>
              !call.side && asked(call, "Run the tool")
                ? shell!.run(call, shell!.nested(nestedAsk))
                : undefined,
            ),
            own((call) => {
              if (call.side || nested(call)) return undefined
              const read = given.filter((prompt) => asked(call, prompt))
              if (read.length > 0) return { text: `Read: ${read.join("; ")}.` }
              return call.turns.some((each) => each.role === "tool")
                ? { text: "Tool done." }
                : undefined
            }),
          )
          const t1 = await start(run, setup)
          const profile = harnesses[setup.agent].box!
          const calls = run.model.mark()
          const mark = t1.mark()

          await t1.prompt("Run the tool")
          await run.model.waitFor(nested, { after: calls })
          if (image) {
            const path = join(run.sandbox.project, "picture.png")
            writeFileSync(path, picture)
            t1.press(`${given[0]} `)
            // Codex on Windows reads keys that come fast as one paste, flushed once they
            // stop for 60 ms (paste_burst.rs, 0.163): the path pasted right after the words
            // would join them as one paste, words and not a path, so the words land first.
            await t1.until(given[0]!)
            // On Windows the paste is keys, and a pause inside them (a loaded runner, seen
            // 2026-11-07, 0.167.0) ends the burst early: the rest lands as text, the path
            // stays words and no image attaches (the trace shows the paste and the screen
            // the path as typed). The path is erased and pasted again, up to three times.
            for (let attempt = 1; ; attempt += 1)
              try {
                // eslint-disable-next-line no-await-in-loop -- One paste after another.
                await t1.confirm(
                  setup.image!.shows,
                  async () => t1.press(`\x1b[200~${path}\x1b[201~`),
                  { timeoutMs: attempt === 1 ? 15_000 : 5_000 },
                )
                break
              } catch (error) {
                // Erased only where the screen shows the path as text: with no path shown the
                // placeholder may be drawn late, and erasing would eat the placeholder and words.
                // eslint-disable-next-line no-await-in-loop -- Read before erasing.
                if (attempt === 3 || !(await t1.screen()).includes("picture.png")) throw error
                t1.press("\x7f".repeat(path.length))
                // eslint-disable-next-line no-await-in-loop -- Erased before the next paste.
                await t1.poll(
                  async () => ((await t1.screen()).includes("picture.png") ? undefined : true),
                  "the pasted path to be erased",
                )
              }
          }
          // Each followed until the record has it, as the chat shows it pending until then.
          const settles = image
            ? []
            : await given.reduce<Promise<(() => Promise<void>)[]>>(
                async (done, prompt) => [...(await done), await prompted(t1, prompt)],
                Promise.resolve([]),
              )
          // Every prompt waits in the harness's queue, shown on its screen, before the tool ends.
          await t1.poll(async () => {
            const shown = await t1.screenText()
            const rows = shown?.rows.join("\n") ?? ""
            return shown && profile.queued(shown) && given.every((prompt) => rows.includes(prompt))
              ? true
              : undefined
          }, "the prompts to be queued while the tool runs")
          held.open()

          for (const prompt of given)
            await item(t1, "assistant", (text) => text.includes("Read:") && text.includes(prompt))
          for (const settled of settles) await settled()
          await through(t1, ["working", "settled"], { after: mark })
          const items = await t1.transcript()
          const users = items.filter((one) => one.role === "user" && one.kind === "text")
          const sent = setup.merges ? [given.join("\n")] : given
          expect(users.map((one) => one.text)).toEqual([
            "Run the tool",
            // The image holds its place in the prompt's text, as its box showed it, or goes
            // beside it.
            ...sent.map((prompt) =>
              image && setup.image!.inline ? `${prompt} ${setup.image!.shows}` : prompt,
            ),
          ])
          const result = items.findIndex((one) => one.kind === "tool-result")
          const at = sent.map((prompt) =>
            items.findIndex((one) => one.role === "user" && one.text.includes(prompt)),
          )
          const answered = items.findIndex(
            (one) => one.role === "assistant" && one.kind === "text" && one.text.includes("Read:"),
          )
          const order = [result, ...at, answered]
          expect(result).toBeGreaterThanOrEqual(0)
          expect(order).toEqual(order.toSorted((a, b) => a - b))
          expect(new Set(order).size).toBe(order.length)
        },
      )

    it("interrupts a running turn, which ends without a normal stop, and takes the next prompt", async ({
      e2e: run,
    }) => {
      const held = gate()
      const answered = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          if (!asked(call, "Take your time")) return undefined
          await held.opened
          answered.open()
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.prompt("Take your time")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Take your time"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.interrupt()

      const ended = await t1.reached("unknown", { after: mark })
      // The harness takes the key a moment after it is written: its own account of the
      // interruption shows before the held reply is let go, which must never show.
      // Claude Code's account, to 2.1.287, is the prompt back in its box, which the runner
      // clears before `interrupt` resolves: then the prompt shows nowhere, its echo gone with
      // the turn. From 2.1.304 it says so, as the others do.
      const account = setup.interrupted("Take your time")
      await t1.poll(
        async () => {
          const shown = await t1.screen()
          return account.test(shown) || !shown.includes("Take your time") ? true : undefined
        },
        "the harness to take the interrupt",
        30_000,
      )
      held.open()
      await answered.opened
      await sleep(3000)
      expect(await t1.screen()).not.toContain("Too late.")
      expect((await texts(t1, "assistant")).join("\n")).not.toContain("Too late.")
      expect(
        t1
          .history()
          .slice(mark)
          .map((one) => one.delivery),
      ).not.toContain("settled")

      // The chat shows where the person interrupted it, in every harness: Antigravity's
      // transcript records no interruption, so the runner tells it there.
      await t1.poll(
        async () => ((await t1.transcript()).some((one) => one.interrupted) ? true : undefined),
        "the chat to show the interruption",
        30_000,
      )

      // The next prompt starts a turn that ends normally, after the interruption in the chat.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: Math.max(next, ended.index) })
      await item(t1, "user", (text) => text.includes("Carry on"))
      const chat = await t1.transcript()
      const noted = chat.findIndex((one) => one.interrupted)
      const carried = chat.findIndex((one) => one.role === "user" && one.text.includes("Carry on"))
      expect(noted).toBeGreaterThanOrEqual(0)
      expect(noted).toBeLessThan(carried)
    })

    it("leaves the box as it was before the interrupted prompt, so the next prompt is sent alone", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        replies("Prompt B only", "Answered B."),
        own(async (call) => {
          if (!asked(call, "Prompt A")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      // Interrupted before any reply, a multi-line prompt: Claude Code puts it back in its box.
      await t1.prompt("Prompt A line one\nPrompt A line two")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Prompt A line one"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.interrupt()
      held.open()
      await sleep(1000)

      await t1.prompt("Prompt B only")
      await t1.until("Answered B.")
      const users = await item(t1, "user", (text) => text.includes("Prompt B only"))
      expect(users).toBe("Prompt B only")
      const sent = (await texts(t1, "user")).filter((text) => text.includes("Prompt"))
      expect(sent.at(-1)).toBe("Prompt B only")
    })

    // Characters a TUI's composer treats as more than text (probed 2026-10-06): a leading `/`
    // is a slash command, a leading `!` runs a shell command in Claude Code and Codex, and a
    // trailing `@name` leaves a file picker open in Codex whose Enter picks. Such a prompt is
    // refused with nothing pressed; the rest, `@` inside it included, reaches the model
    // exactly as written.
    for (const words of [
      "email me at a@b.co about it",
      "fix the @no thing now",
      "@README.md what is this",
      "#note this down",
      "& what now",
      "it costs $5",
      "see $1.50",
      "one\r\ntwo",
    ]) {
      it(`gives its agent "${words}" as the person's message`, async ({ e2e: run }) => {
        writeFileSync(join(run.sandbox.project, "README.md"), "# Readme\n")
        // A CRLF or a lone CR is taken as a line feed.
        const said = words.replace(/\r\n?/g, "\n")
        run.model.use(own((call) => (asked(call, said) ? { text: "Got the words." } : undefined)))
        const t1 = await start(run, setup)
        const calls = run.model.mark()

        await t1.prompt(words)
        const seen = await run.model.waitFor((call) => !call.side && latest(call).includes(said), {
          after: calls,
        })
        expect(latest(seen)).toContain(said)
        await t1.until("Got the words.")
      })
    }

    // A leading ! is a shell command, which each harness runs in its shell mode: the chat
    // types the ! as a key, then pastes the command.
    it("runs a ! command from the chat, the same command again, and a multi-line one", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const file = (name: string) => join(run.sandbox.project, name)
      // Once it holds what the command wrote: the shell creates the file before it writes
      // to it, and on a Windows runner it was read in between, empty.
      const made = (name: string) =>
        t1.poll(
          () => (existsSync(file(name)) && readFileSync(file(name), "utf8").trim()) || undefined,
          `${name} to be made by the shell command`,
          15_000,
        )

      await t1.prompt("!echo first > bang-one.txt")
      expect((await made("bang-one.txt")).trim()).toBe("first")
      // Its row stays in the history, which must not pass for the next one's paste.
      await t1.prompt("!echo first > bang-one.txt")
      await t1.prompt("! echo second > bang-two.txt")
      expect((await made("bang-two.txt")).trim()).toBe("second")
      await t1.prompt("!echo third > bang-three.txt\necho fourth > bang-four.txt")
      expect((await made("bang-three.txt")).trim()).toBe("third")
      expect((await made("bang-four.txt")).trim()).toBe("fourth")
    })

    it("runs a long ! command where its shell mode expands it, and never its placeholder", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const lines = Array.from({ length: 16 }, (_, at) => `echo ${at} >> long.txt`)
      const long = join(run.sandbox.project, "long.txt")
      const command = lines.join("\n")
      const sent = t1.prompt(`!${command}`)
      // What its shell mode is given: Antigravity's on Windows, its lines joined, shows whole.
      const { box } = harnesses[setup.agent]
      if (box.shell.expands || !box.collapses(box.shell.command?.(command) ?? command)) {
        await sent
        await t1.poll(
          () =>
            existsSync(long) && readFileSync(long, "utf8").trim().split("\n").length === 16
              ? true
              : undefined,
          "all 16 lines to run",
          15_000,
        )
      } else {
        // Antigravity shows it as "[Pasted text #1 +16 lines]" and would run that text.
        await expect(sent).rejects.toMatchObject({
          code: "PROMPT_FAILED",
          message: expect.stringMatching(/placeholder/),
        })
        await sleep(1500)
        expect(existsSync(long)).toBe(false)
        expect(await t1.screen()).not.toMatch(/command not found/)
      }
    })

    it("hands what the box holds to the chat, and a draft back, with nothing sent", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      const taken = async () => (await run.deck.terminals.takeBox(t1.id)).returned
      const put = async (text: string) =>
        (await run.deck.terminals.putBox({ terminalId: t1.id, text })).placed
      const empty = () =>
        t1.poll(async () => {
          const screen = await t1.screenText()
          const box = screen && harnesses[setup.agent].box.read(screen)
          return box && box.mode === "prompt" && isEmpty(box) ? true : undefined
        }, "its box to read empty")

      // A paragraph that wraps, a blank line and a line, short of what a box shows as a placeholder.
      const words = `${"a paragraph that goes on ".repeat(8).trim()}\n\nits last`
      write(`\x1b[200~${words.replaceAll("\n", "\r")}\x1b[201~`)
      await t1.until("its last")
      expect(await taken()).toBe(words)
      await empty()

      // The same words there and back, as the person switches between the two.
      expect(await put(words)).toBe(true)
      await t1.until("its last")
      expect(await taken()).toBe(words)
      await empty()

      // A shell mode's command goes with its `!`, and comes back to it.
      t1.press("!")
      await t1.poll(
        async () =>
          harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) || undefined,
        "its box in its shell mode",
      )
      t1.press("ls -la")
      await t1.until("ls -la")
      expect(await taken()).toBe("!ls -la")
      await empty()
      expect(await put("!ls -la")).toBe(true)
      expect(await taken()).toBe("!ls -la")
      await empty()
      expect(run.model.calls.slice(calls).filter((call) => !call.side)).toEqual([])
    })

    it("leaves in the box what it can't read whole, and keeps a draft that would open a picker", async ({
      e2e: run,
    }) => {
      writeFileSync(join(run.sandbox.project, "notes.md"), "Notes.\n")
      run.model.use(replies("And this", "Got both."))
      const t1 = await start(run, setup)
      const box = following(run, t1)
      const lines = Array.from(
        { length: 40 },
        (_, at) => `Line ${at + 1} of a long paste, in words`,
      )
      const placed = (text: string) => run.deck.terminals.putBox({ terminalId: t1.id, text })

      await expect(placed("/help me")).resolves.toEqual({ placed: false })
      await expect(placed("see @notes")).resolves.toEqual({ placed: false })
      await expect(placed("see $skill")).resolves.toEqual({ placed: false })
      expect(await t1.screen()).not.toContain("help me")

      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      write(`\x1b[200~${lines.join("\r")}\x1b[201~`)
      await box.shows((shown) => shown !== null)
      await expect(run.deck.terminals.takeBox(t1.id)).resolves.toEqual({ returned: null })
      write("\x15")
      await box.shows((shown) => shown === null)
      // A command of its own stays too: the chat could neither send it nor put it back.
      t1.press("/he")
      await box.shows((shown) => shown?.text === "/he")
      await expect(run.deck.terminals.takeBox(t1.id)).resolves.toEqual({ returned: null })
      write("\x15")
      await box.shows((shown) => shown === null)
      write(`\x1b[200~${lines.join("\r")}\x1b[201~`)
      await box.shows((shown) => shown !== null)
      // There's something in the box: a draft stays where it is, and the box's text as well.
      await expect(placed("a draft")).resolves.toEqual({ placed: false })
      await t1.prompt("And this")
      await t1.until("Got both.")
      const over = await item(t1, "user", (text) => text.includes("And this"))
      expect(over.split("\n").map((line) => line.trim())).toEqual(
        along(setup, lines.join("\n"), "And this").split("\n"),
      )
      box.stop()
    })

    it("hands what the box holds to the chat mid-turn, the turn going on", async ({ e2e: run }) => {
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()
      await t1.prompt("Hold on")
      await t1.reached("working", { after: mark })
      t1.press("half a thought")
      await t1.until("half a thought")

      await expect(run.deck.terminals.takeBox(t1.id)).resolves.toEqual({
        returned: "half a thought",
      })
      expect(t1.summary().activity?.state).toBe("working")
      held.open()
      await t1.until("Held.")
      expect(await t1.screen()).not.toContain("half a thought")
    })

    it("clears what the box holds as the person asks, whatever it is, and nothing else", async ({
      e2e: run,
    }) => {
      run.model.use(replies("A message", "Got it."))
      const t1 = await start(run, setup)
      const box = following(run, t1)
      const calls = run.model.calls.length
      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
      const clear = (seen: string) => run.deck.terminals.clearBox({ terminalId: t1.id, seen })
      const clears = async (fits: (shown: AgentBox) => boolean) => {
        const shown = await box.shows((now) => now !== null && fits(now))
        await expect(clear(shown!.text)).resolves.toEqual({ cleared: true })
        await box.shows((now) => now === null)
      }

      // A command, its picker shut, then open, and what was typed since it was shown stays.
      t1.press("/help me")
      await t1.until("/help me")
      await expect(clear("/help")).resolves.toEqual({ cleared: false })
      expect(await t1.screen()).toContain("/help me")
      await clears((shown) => shown.text === "/help me")
      t1.press("/he")
      await clears((shown) => shown.text === "/he")

      // Rows it can't read as anyone's, and a placeholder of what it never shows.
      write("\x1b[200~Unknown words\rtheir next line\x1b[201~")
      await clears((shown) => shown.text.includes("their next line"))
      const long = Array.from({ length: 40 }, (_, at) => `Line ${at + 1} of a paste`).join("\r")
      write(`\x1b[200~${"a long paste ".repeat(120)}\r${long}\x1b[201~`)
      await box.shows((shown) => shown !== null)
      await clears(() => true)

      // Only the end of it shows.
      for (let at = 0; at < 16; at += 1) {
        write(`\x1b[200~Part ${at} of it\rits next line\rits last line\x1b[201~`)
        await t1.until(`Part ${at} of it`)
      }
      // Handing it over would lose what doesn't show: it stays, marked as a tail.
      const allIn = (shown: AgentBox | null) =>
        shown?.tail === true && shown.text.includes("Part 15 of it")
      const tail = await box.shows(allIn)
      await expect(run.deck.terminals.takeBox(t1.id)).resolves.toEqual({ returned: null })
      // A prompt could be back over what shows, unseen: it stays while one is on its way.
      const { receipts } = (run.deck.terminals as unknown as { typing: { receipts: Receipts } })
        .typing
      const { ref } = await receipts.expect(t1.id, "On its way")
      receipts.sent(t1.id, ref)
      await expect(clear(tail!.text)).resolves.toEqual({ cleared: false })
      receipts.failed(t1.id, ref)
      await clears(allIn)

      // A shell mode's command goes with the mode: what's next is a message, and nothing ran.
      t1.press("!")
      await t1.poll(
        async () =>
          harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) || undefined,
        "its box in its shell mode",
      )
      t1.press("ls -la")
      await clears((shown) => shown.mode === "shell" && shown.text === "ls -la")
      expect(run.model.calls.slice(calls).filter((call) => !call.side)).toEqual([])

      await t1.prompt("A message")
      await t1.until("Got it.")
      expect(await item(t1, "user", (text) => text.includes("A message"))).toBe("A message")
      box.stop()
    })

    it("clears mid-turn, the turn going on, and a prompt back in the box goes with it", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        }),
      )
      const t1 = await start(run, setup)
      const box = following(run, t1)
      const mark = t1.mark()
      await t1.prompt("Hold on")
      await t1.reached("working", { after: mark })
      t1.press("/help me")
      await box.shows((shown) => shown?.text === "/help me")
      await expect(
        run.deck.terminals.clearBox({ terminalId: t1.id, seen: "/help me" }),
      ).resolves.toEqual({
        cleared: true,
      })
      expect(t1.summary().activity?.state).toBe("working")
      held.open()
      await t1.until("Held.")
      await t1.poll(
        () => (t1.summary().activity?.state === "working" ? undefined : true),
        "its turn to end",
      )

      run.deck.terminals.write({ terminalId: t1.id, data: "\x1b[200~Queued words\x1b[201~" }, "e2e")
      await t1.until("Queued words")
      const { receipts } = (run.deck.terminals as unknown as { typing: { receipts: Receipts } })
        .typing
      const { ref } = await receipts.expect(t1.id, "Queued words")
      receipts.sent(t1.id, ref)
      await receipts.putBack(t1.id)
      await box.shows((shown) => shown?.known === true)
      await expect(
        run.deck.terminals.clearBox({ terminalId: t1.id, seen: "Queued words" }),
      ).resolves.toEqual({
        cleared: true,
      })
      expect((await t1.detail()).prompts?.find((each) => each.ref === ref)?.state).toBe("withdrawn")
      box.stop()
    })

    it("refuses a shell command over a draft, which it can't go along with", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const left = join(run.sandbox.project, "left.txt")
      const box = following(run, t1)
      t1.press("Half a thought")
      await t1.until("Half a thought")

      await expect(t1.prompt("!echo left > left.txt")).rejects.toMatchObject({
        code: "CONFLICT",
        reason: "draft",
      })
      // The refusal says to clear it above: the note is there to click as it comes.
      expect(box.now()?.text).toBe("Half a thought")
      box.stop()
      await sleep(1000)
      expect(existsSync(left)).toBe(false)
      expect(await t1.screen()).toContain("Half a thought")
    })

    it("runs a ! command from a box left in its shell mode", async ({ e2e: run }) => {
      const t1 = await start(run, setup)
      const left = join(run.sandbox.project, "left.txt")
      t1.press("!")
      await t1.poll(
        async () =>
          harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) || undefined,
        "its box in its shell mode",
      )
      // A command that makes the file in every harness's shell: bash, PowerShell or cmd.
      await t1.prompt("!echo left > left.txt")
      await t1.poll(() => existsSync(left) || undefined, "left.txt to be made", 15_000)
    })

    for (const words of [
      "/tmp is full, what now",
      "!",
      "!echo @",
      "!echo $",
      "/clear",
      "look at @READ",
      "see @",
      "see @README ",
      "look at $skill",
      "list $",
      "see $pdf2",
      "see $ns:skill",
      "hi\f",
      "x\x1b[201~\x15!touch pwned\r",
    ]) {
      it(`refuses "${words}", pressing nothing`, async ({ e2e: run }) => {
        writeFileSync(join(run.sandbox.project, "README.md"), "# Readme\n")
        run.model.use(own((call) => (asked(call, words) ? { text: "Got the words." } : undefined)))
        const t1 = await start(run, setup)
        const calls = run.model.mark()
        // What the screen shows of them already, as a greeting may ("Whoa, fancy meeting
        // you here!", one of Codex's).
        const shown = occurrences(await t1.screen(), words.slice(0, 6))

        await expect(t1.prompt(words)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
        await sleep(1000)
        // Nothing was typed, so no command ran and no file was picked, and nothing was sent.
        expect(occurrences(await t1.screen(), words.slice(0, 6))).toBe(shown)
        expect(run.model.calls.slice(calls)).toEqual([])
      })
    }
  })
}
