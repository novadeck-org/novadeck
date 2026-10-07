/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { TranscriptItem } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate, latest } from "./model/script.js"
import { own, replies, start, through, turn } from "./scenarios.js"

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

    it("takes a prompt as the person's own: the terminal is named as a typed prompt names it", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Greet the chat", "Hello, chat."))
      const chat = await start(run, setup)
      const typed = await start(run, setup)

      await chat.prompt("Greet the chat")
      await chat.until("Hello, chat.")
      await turn(typed, "Greet the chat", "Hello, chat.")
      // A harness whose hooks name no prompt (Antigravity) may leave a quick turn's
      // prompt unattributed, which is the same for both: the two are named alike.
      await sleep(5000)

      const [one, other] = [chat.summary(), typed.summary()]
      expect(one.titleSource).toEqual(other.titleSource)
      if (other.titleSource.kind === "fallback") expect(one.title).toBe(other.title)
    })

    it("gives its agent a multi-line prompt as one prompt, whole in the transcript", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Third line of the chat", "Got three lines."))
      const t1 = await start(run, setup)
      const mark = t1.mark()
      const lines = ["First line of the chat", "Second line of the chat", "Third line of the chat"]

      await t1.prompt(lines.join("\n"))
      await t1.until("Got three lines.")
      await through(t1, ["working", "settled"], { after: mark })

      const user = await item(t1, "user", (text) => text.includes("Third line of the chat"))
      expect(user.split("\n").map((line) => line.trim())).toEqual(lines)
      await item(t1, "assistant", (text) => text.includes("Got three lines."))
      // One prompt, one user turn: the line breaks never submitted anything.
      expect((await texts(t1, "user")).filter((text) => text.includes("First line"))).toHaveLength(
        1,
      )
    })

    it("gives its agent a long prompt that its box may show as a placeholder", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Line 40 of the long prompt", "Read all forty."))
      const t1 = await start(run, setup)
      const mark = t1.mark()
      const lines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the long prompt`)

      await t1.prompt(lines.join("\n"))
      await t1.until("Read all forty.")
      await through(t1, ["working", "settled"], { after: mark })

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

    it("refuses a prompt while a draft is in the box, rather than merging into it", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Shall I go on", "Going on."))
      const t1 = await start(run, setup)
      const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")

      // What a failed send leaves: text in the box that no Enter followed.
      write("\x1b[200~Say hello\x1b[201~")
      await t1.until("Say hello")
      await expect(t1.prompt("Shall I go on")).rejects.toMatchObject({ code: "CONFLICT" })
      await sleep(500)
      // Nothing was pasted or pressed: the box holds the draft alone, and no turn started.
      const shown = await t1.screen()
      expect(shown).not.toContain("Shall I go on")
      expect(shown.split("Say hello")).toHaveLength(2)
      expect(await texts(t1, "user")).toEqual([])

      // The person clears it, line by line as every harness's box takes, and the next
      // prompt goes alone.
      for (let step = 0; step < 4; step += 1) {
        write("\x15\x7f".repeat(5))
        await sleep(150)
      }
      write("\x15")
      await sleep(500)
      const mark = t1.mark()
      await t1.prompt("Shall I go on")
      await t1.until("Going on.")
      await through(t1, ["working", "settled"], { after: mark })
      expect(await item(t1, "user", (text) => text.includes("Shall I go on"))).toBe("Shall I go on")
    })

    it("refuses a prompt a TUI would read as a command, writing nothing", async ({ e2e: run }) => {
      const t1 = await start(run, setup)

      for (const text of ["/clear", "see @src", "use $", "Hello\x15there", "\x1b[201~x"])
        await expect(t1.prompt(text)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
      await sleep(500)
      const shown = await t1.screen()
      for (const typed of ["@src", "/clear", "!ls"]) expect(shown).not.toContain(typed)
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

      await t1.prompt(
        "Thanks \u2764\ufe0f heart \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family \u65e5\u672c\u8a9e",
      )
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
      run.model.use(
        replies("First quick", "Did first."),
        replies("Second quick", "Did second."),
        replies("Third one", "Did third."),
        replies("Fourth one", "Did fourth."),
        replies("Five\nlines\nof\nit\nhere", "Did five."),
        replies("Then one", "Did then."),
      )
      const t1 = await start(run, setup)

      // Each group goes back to back; between them the turns end, as an agent that is given
      // a prompt as its turn ends may drop it from its queue (Antigravity 1.3.1 did, once).
      await t1.prompt("First quick")
      await t1.prompt("Second quick")
      await item(t1, "assistant", (text) => text.includes("Did second."))
      await Promise.all([t1.prompt("Third one"), t1.prompt("Fourth one")])
      await item(t1, "assistant", (text) => text.includes("Did fourth."))
      await t1.prompt("Five\nlines\nof\nit\nhere")
      await t1.prompt("Then one")

      for (const reply of ["Did first.", "Did second.", "Did third.", "Did fourth.", "Did then."])
        await item(t1, "assistant", (text) => text.includes(reply))
      const users = await texts(t1, "user")
      for (const sent of ["First quick", "Second quick", "Third one", "Fourth one", "Then one"])
        expect(users.filter((text) => text === sent)).toHaveLength(1)
    })

    it("queues a prompt given mid-turn as the person's would be, and answers both", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Start the long job")) return undefined
          await held.opened
          return { text: "Long job done." }
        }),
        replies("Then sum it up", "Summed up."),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.prompt("Start the long job")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Start the long job"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.prompt("Then sum it up\nin one line\n\nthanks")
      held.open()

      await t1.until("Summed up.")
      await through(t1, ["working", "settled"], { after: mark })
      await item(t1, "user", (text) => text.includes("Start the long job"))
      await item(t1, "user", (text) => text.includes("Then sum it up") && text.includes("thanks"))
      await item(t1, "assistant", (text) => text.includes("Long job done."))
      await item(t1, "assistant", (text) => text.includes("Summed up."))
    })

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
      // Claude Code's account is the prompt back in its box, which the runner clears before
      // `interrupt` resolves: then the prompt shows nowhere, its echo gone with the turn.
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

      // The next prompt starts a turn that ends normally.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: Math.max(next, ended.index) })
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
      const made = (name: string) =>
        t1.poll(
          () => (existsSync(file(name)) ? readFileSync(file(name), "utf8") : undefined),
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
      const sent = t1.prompt(`!${lines.join("\n")}`)
      if (harnesses[setup.agent].box.shell.expands) {
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

    it("keeps a message out of a box left in its shell mode, and takes it once that's undone", async ({
      e2e: run,
    }) => {
      const t1 = await start(run, setup)
      const left = join(run.sandbox.project, "left.txt")
      const shelled = async (on: boolean) =>
        await t1.poll(
          async () =>
            harnesses[setup.agent].box.shell.footer((await t1.screen()).split("\n")) === on ||
            undefined,
          on ? "its box in its shell mode" : "its box out of its shell mode",
        )
      // The person's own `!`, typed in the terminal and left there.
      t1.press("!")
      await shelled(true)
      await expect(t1.prompt("touch left.txt")).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(t1.prompt("!touch left.txt")).rejects.toMatchObject({ code: "CONFLICT" })
      await sleep(1000)
      expect(existsSync(left)).toBe(false)
      t1.press("\x7f")
      await shelled(false)
      await t1.prompt("!touch left.txt")
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

        await expect(t1.prompt(words)).rejects.toMatchObject({ code: "PROMPT_REFUSED" })
        await sleep(1000)
        // Nothing was typed, so no command ran and no file was picked, and nothing was sent.
        expect(await t1.screen()).not.toContain(words.slice(0, 6))
        expect(run.model.calls.slice(calls)).toEqual([])
      })
    }
  })
}
