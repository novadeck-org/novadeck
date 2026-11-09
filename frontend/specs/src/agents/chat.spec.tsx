import { vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import type { Locator } from "vitest/browser"

import {
  attachments,
  chatOf,
  composer,
  conversation,
  imageFile,
  openChat,
  openChatDemo,
  pasteInto,
  requestCard,
} from "../support/chat"
import { expectStaysTrue } from "../support/layouts"
import { closeToasts } from "../support/toasts"
import {
  chooseView,
  commandInput,
  expectStaysAbsent,
  terminal,
  terminalTab,
  terminalText,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// The scenario's answer and settlement delays. Specs use the selected backend through
// the app, so they keep their timing expectations here rather than importing its adapter.
const answerMs = 400
const answeredMs = 500

// Turns the chat view on or off in Preferences → Experimental, and closes Preferences.
const setChatView = async (on: boolean): Promise<void> => {
  await closeToasts()
  // A toast landing after them would take the click (the demo raises its asks as it boots);
  // the keys reach the button under it.
  ;(page.getByRole("button", { name: "Workspace preferences" }).element() as HTMLElement).focus()
  await userEvent.keyboard("{Enter}")
  const dialog = page.getByRole("dialog", { name: "Preferences" })
  await dialog.getByRole("tab", { name: "Experimental" }).click()
  const chatView = dialog.getByRole("switch", { name: "Chat view" })
  await chatView.click()
  await expect.element(chatView).toHaveAttribute("aria-checked", String(on))
  await userEvent.keyboard("{Escape}")
  await expect.element(dialog).not.toBeInTheDocument()
}

describe("The chat view", () => {
  it("shows the chat of a terminal running an agent and not of another", async () => {
    await openChatDemo()
    await openChat("Checkout implementation")
    await terminalTab("Dev server").click()
    await expect.element(commandInput("Dev server")).toBeVisible()
    await expect.element(chatOf("Dev server")).not.toBeInTheDocument()
  })

  it("shows no chat while it is off", async () => {
    await openChatDemo("/", { chatView: false })
    await terminalTab("Build").click()
    await expect.element(commandInput("Build")).toBeVisible()
    await expect.element(chatOf("Build")).not.toBeInTheDocument()
  })

  it("shows no chat without Experimental, though it was turned on", async () => {
    await openChatDemo("/", { experimental: false })
    await terminalTab("Build").click()
    await expect.element(commandInput("Build")).toBeVisible()
    await expectStaysAbsent(chatOf("Build"))
  })

  it("goes back to the terminal's output once Experimental is turned off", async () => {
    await openChatDemo()
    await openChat("Build")
    await page.getByRole("button", { name: "Workspace preferences" }).click()
    const dialog = page.getByRole("dialog", { name: "Preferences" })
    await dialog.getByRole("tab", { name: "About" }).click()
    const experimental = dialog.getByRole("switch", { name: "Experimental" })
    await expect.element(experimental).toHaveAttribute("aria-checked", "true")
    await experimental.click()
    await expect.element(dialog.getByRole("tab", { name: "Experimental" })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await expect.element(chatOf("Build")).not.toBeInTheDocument()
    await expect.poll(() => terminalText("Build")).toContain("Added the order summary")
  })

  it("turns on from Preferences → Experimental, and off again back to the terminal's output", async () => {
    await openChatDemo("/", { chatView: false })
    await terminalTab("Build").click()
    await setChatView(true)
    await expect
      .element(chatOf("Build").getByText("It passes now.", { exact: false }))
      .toBeVisible()
    await setChatView(false)
    await expect.element(chatOf("Build")).not.toBeInTheDocument()
    await expect.poll(() => terminalText("Build")).toContain("Added the order summary")
  })
})

describe("A chat's conversation", () => {
  it("shows the person's prompt, the agent's formatted reply and its tool calls", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const log = conversation(chat)
    await expect
      .element(log.getByText("Build the app and tell me how big the bundle is."))
      .toBeVisible()
    await expect.element(log.getByRole("table")).toBeVisible()
    await expect.element(log.getByRole("link", { name: "http://localhost:4173" })).toBeVisible()
    await expect.element(log.getByRole("code").first()).toBeVisible()
  })

  it("opens a tool call to what it changed, closed until clicked", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const row = chat.getByRole("button", { name: /^edited .*total\.ts/ })
    await expect.element(row).toHaveAttribute("aria-expanded", "false")
    await row.click()
    await expect.element(row).toHaveAttribute("aria-expanded", "true")
    await expect
      .element(chat.getByRole("region", { name: "Changes" }).getByText(/cart\/selectors/))
      .toBeVisible()
  })

  it("opens a command to what it printed, and says when it failed", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const row = chat.getByRole("button", { name: /^ran pnpm build · exit 1/ })
    await row.click()
    await expect
      .element(chat.getByRole("region", { name: "Result" }).getByText(/error during build/))
      .toBeVisible()
  })

  it("names a subagent's report by the subagent, apart from the commands", async () => {
    await openChatDemo()
    const chat = await openChat("Checkout review")
    await expect.element(chat.getByRole("group", { name: "Subagent explorer 1" })).toBeVisible()
    await expect
      .element(chat.getByRole("button", { name: "explorer 1, subagent" }))
      .toHaveAttribute("aria-expanded", "false")
  })
})

// The caret at the start of the box, as Ctrl+Home puts it on Linux and Windows and Cmd+Up on macOS.
const caretToStart = (chat: Locator): void => {
  const box = composer(chat).element() as HTMLTextAreaElement
  box.setSelectionRange(0, 0)
}

describe("Recalling earlier prompts in the chat's box", () => {
  const first = "Build the app and tell me how big the bundle is."

  it("walks back through the prompts with Up and returns to the draft with Down", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "Run the linter")
    await userEvent.keyboard("{Enter}")
    await expect.element(composer(chat)).toHaveValue("")
    await userEvent.type(composer(chat), "half a thought")
    caretToStart(chat)
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue("Run the linter")
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(first)
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(first)
    await userEvent.keyboard("{ArrowDown}")
    await expect.element(composer(chat)).toHaveValue("Run the linter")
    await userEvent.keyboard("{ArrowDown}")
    await expect.element(composer(chat)).toHaveValue("half a thought")
  })

  it("takes a second Up from the end of a one-line draft, the first going to its start", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "half a thought")
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue("half a thought")
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(first)
    await userEvent.keyboard("{ArrowDown}")
    await expect.element(composer(chat)).toHaveValue("half a thought")
  })

  it("recalls a shell command as it was typed", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "!")
    await userEvent.keyboard("ls -la{Enter}")
    await expect.element(conversation(chat).getByText("!ls -la")).toBeVisible()
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue("!ls -la")
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(first)
  })

  it("leaves Up to a long draft's rows, and starts from the start of the box", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const long = "a long draft that has to wrap onto a second row ".repeat(6).trim()
    await userEvent.click(composer(chat))
    await userEvent.fill(composer(chat), long)
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(long)
    caretToStart(chat)
    await userEvent.keyboard("{ArrowUp}")
    await expect.element(composer(chat)).toHaveValue(first)
    await userEvent.keyboard("{ArrowDown}")
    await expect.element(composer(chat)).toHaveValue(long)
  })
})

describe("Sending a prompt from the chat", () => {
  it("shows it at once and then the agent's reply", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await expect.element(composer(chat)).toHaveFocus()
    await userEvent.type(composer(chat), "Run the linter")
    await userEvent.keyboard("{Enter}")
    await expect.element(conversation(chat).getByText("Run the linter")).toBeVisible()
    await expect.element(composer(chat)).toHaveValue("")
    await expect
      .element(conversation(chat).getByText("Done: Run the linter. Nothing else changed."), {
        timeout: 5000,
      })
      .toBeVisible()
  })

  it("warns of a message the agent would read as a command and keeps Send disabled", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "/tmp is full")
    await expect.element(chat.getByText(/Can't start with \//)).toBeVisible()
    await expect.element(chat.getByRole("button", { name: "Send" })).toBeDisabled()
    await userEvent.keyboard("{Enter}")
    await expect.element(composer(chat)).toHaveValue("/tmp is full")
  })

  it("runs a shell command that starts with !, shown as the person's line and its run", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "!")
    await expect.element(chat.getByText("shell", { exact: true })).toBeVisible()
    await expect.element(chat.getByText(/Runs in Claude's shell/)).toBeInTheDocument()
    await expect.element(chat.getByRole("button", { name: "Send" })).toBeDisabled()
    await userEvent.keyboard("ls -la{Enter}")
    await expect.element(composer(chat)).toHaveValue("")
    await expect.element(conversation(chat).getByText("!ls -la")).toBeVisible()
    await expect.element(conversation(chat).getByText("ran", { exact: true }).last()).toBeVisible()
  })

  it("keeps Shift+Enter for a new line", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "one")
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}")
    await userEvent.type(composer(chat), "two")
    await expect.element(composer(chat)).toHaveValue("one\ntwo")
  })

  it("says why a prompt didn't go and puts it back in the box", async () => {
    await openChatDemo()
    // Codex in Checkout review waits for the person's answer.
    const chat = await openChat("Checkout review")
    await userEvent.type(composer(chat), "More please")
    await userEvent.keyboard("{Enter}")
    await expect.element(chat.getByRole("alert").getByText(/waiting for your answer/)).toBeVisible()
    await expect.element(composer(chat)).toHaveValue("More please")
  })

  it("queues a prompt sent while the agent works, which Stop gives back to the box", async () => {
    await openChatDemo()
    // Claude Code in Tests still works in the background.
    const chat = await openChat("Tests")
    await userEvent.type(composer(chat), "More please")
    await userEvent.keyboard("{Enter}")
    await expect.element(composer(chat)).toHaveValue("")
    await expect.element(chat.getByRole("alert")).not.toBeInTheDocument()
    await chat.getByRole("button", { name: "Stop" }).click()
    await expect.element(composer(chat)).toHaveValue("More please")
  })
})

describe("Pasting an image into the chat", () => {
  it("shows it as a chip once uploaded and sends it with the next message", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const left = await pasteInto(composer(chat), [await imageFile("shot.png")])
    expect(left).toBe(false)
    const chip = attachments(chat).getByRole("listitem")
    await expect.element(chip.getByRole("img", { name: "shot.png" })).toBeVisible()
    await expect.element(chip.getByRole("button", { name: "Remove shot.png" })).toBeVisible()
    // Saved on the agent's machine, it is ready to send, with no words.
    await expect.element(chip.getByRole("status")).not.toBeInTheDocument()
    // Its placeholder went into the box at the caret, which the words go on after.
    await expect.element(composer(chat)).toHaveValue("[Image #1] ")
    await expect.element(chip.getByText("#1")).toBeVisible()
    await userEvent.type(composer(chat), "What is this?")
    await userEvent.keyboard("{Enter}")
    await expect.element(attachments(chat)).not.toBeInTheDocument()
    // The demo's agent records each image where it stood in the prompt, as the harnesses do.
    await expect
      .element(conversation(chat).getByText(/\[Image #1\]\s+What is this\?/))
      .toBeVisible()
  })

  it("sends images alone, and lets one go before it does", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await pasteInto(composer(chat), [await imageFile("a.png"), await imageFile("b.png")])
    await chat.getByRole("button", { name: "Remove a.png" }).click()
    await expect.element(chat.getByRole("img", { name: "a.png" })).not.toBeInTheDocument()
    // Its placeholder went with it.
    await expect.element(composer(chat)).toHaveValue("[Image #2] ")
    await expect.element(chat.getByRole("button", { name: "Send" })).toBeEnabled()
    await chat.getByRole("button", { name: "Send" }).click()
    await expect.element(conversation(chat).getByText("[Image #1]", { exact: true })).toBeVisible()
  })

  it("brings the images back to the box with the words when the prompt didn't go", async () => {
    await openChatDemo()
    // Codex in Checkout review waits for the person's answer.
    const chat = await openChat("Checkout review")
    await pasteInto(composer(chat), [await imageFile("shot.png")])
    await expect.element(attachments(chat).getByRole("status")).not.toBeInTheDocument()
    await userEvent.type(composer(chat), "More please")
    await userEvent.keyboard("{Enter}")
    await expect.element(chat.getByRole("alert").getByText(/waiting for your answer/)).toBeVisible()
    await expect.element(composer(chat)).toHaveValue("[Image #1] More please")
    await expect.element(chat.getByRole("img", { name: "shot.png" })).toBeVisible()
  })

  it("keeps the images for their terminal across a change of view", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await pasteInto(composer(chat), [await imageFile("shot.png")])
    await chooseView("Grid")
    const grid = terminal("Build").getByRole("region", { name: "Build chat" })
    await expect.element(grid.getByRole("img", { name: "shot.png" })).toBeVisible()
  })

  it("refuses them in a shell command, and says why", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "!ls")
    await pasteInto(composer(chat), [await imageFile("shot.png")])
    await expect
      .element(chat.getByRole("alert").getByText("A shell command takes text only."))
      .toBeVisible()
    await expect.element(attachments(chat)).not.toBeInTheDocument()
  })

  it("leaves a paste of text to the box", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const data = new DataTransfer()
    data.setData("text/plain", "pasted words")
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    })
    composer(chat).element().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe("Reading the chat", () => {
  it("leaves focus on a tool row the person clicked", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const row = chat.getByRole("button", { name: /^edited .*total\.ts/ })
    await row.click()
    await expect.element(row).toHaveFocus()
    // The workspace would send typing back to the composer a frame after a click.
    await expectStaysTrue(() => document.activeElement === row.element(), "focus on the row")
  })

  it("lets the person select text, which stays selected", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const reply = conversation(chat).getByText("It passes now.", { exact: false })
    await reply.click({ clickCount: 3 })
    await expect.poll(() => window.getSelection()?.toString()).toContain("It passes now.")
    await expectStaysTrue(
      () => window.getSelection()?.toString().includes("It passes now.") === true,
      "the selection",
    )
  })
})

describe("A chat's unsent draft", () => {
  it("stays with its terminal across a change of view", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "not yet")
    await chooseView("Grid")
    const grid = terminal("Build").getByRole("region", { name: "Build chat" })
    await expect.element(composer(grid)).toHaveValue("not yet")
  })
})

describe("An Antigravity terminal's chat", () => {
  it("shows its conversation and answers a prompt, though it reports no status", async () => {
    await openChatDemo()
    const chat = await openChat("Runtime")
    await expect.element(chat.getByRole("button", { name: /^ran / }).first()).toBeVisible()
    await userEvent.type(composer(chat), "Check the logs")
    await userEvent.keyboard("{Enter}")
    await expect.element(conversation(chat).getByText("Check the logs")).toBeVisible()
    await expect
      .element(conversation(chat).getByText(/Done: Check the logs/), { timeout: 5000 })
      .toBeVisible()
  })
})

describe("Stopping an agent from the chat", () => {
  it("ends its turn and drops the working line", async () => {
    await openChatDemo()
    const chat = await openChat("Tests")
    await expect.element(chat.getByRole("status").getByText(/^Working/)).toBeVisible()
    await chat.getByRole("button", { name: "Stop" }).click()
    await expect.element(chat.getByRole("button", { name: "Stop" })).not.toBeInTheDocument()
    await expect
      .element(chat.getByRole("status").getByText("Stopped before it finished"))
      .toBeVisible()
  })
})

describe("A request that waits on the person", () => {
  context("when it shows", () => {
    it("names what it asks and its answers, which the chat takes itself", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await expect.element(card.getByText("pnpm test --filter checkout").first()).toBeVisible()
      await expect
        .element(card.getByLabelText("What it asks"))
        .toHaveTextContent("pnpm test --filter checkout")
      await expect.element(card.getByRole("button", { name: "Yes, proceed" })).toBeVisible()
      await expect
        .element(card.getByRole("button", { name: "Answer in terminal" }))
        .not.toBeInTheDocument()
    })

    it("takes the keys of a terminal's menu, and leaves the box's words alone", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await expect.element(composer(chat)).toHaveFocus()
      await userEvent.keyboard("hello")
      await expect.element(composer(chat)).toHaveValue("hello")
      card.getByRole("button", { name: "Yes, proceed" }).element().focus()
      await userEvent.keyboard("{ArrowDown}")
      await expect
        .element(card.getByRole("button", { name: /^Yes, and don't ask again/ }))
        .toHaveFocus()
    })
  })

  context("when approved from the chat", () => {
    it("goes away, and the agent carries on", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await card.getByRole("button", { name: "Yes, proceed" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(conversation(chat).getByText(/The checkout tests pass/), { timeout: 5000 })
        .toBeVisible()
    })
  })

  context("once answered", () => {
    it("shows it as answered, without its buttons, until the agent reports it settled", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      // Settlement belongs to the agent. Hold it while inspecting the answered card,
      // including when trace recording takes longer than the demo's transient state.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        await card.getByRole("button", { name: "Yes, proceed" }).click()
        await vi.advanceTimersByTimeAsync(answerMs)
        await expect.element(card.getByText(/Answered\. Waiting for Codex/)).toBeVisible()
        await expect
          .element(card.getByRole("button", { name: "Yes, proceed" }))
          .not.toBeInTheDocument()
        await expect.element(card.getByRole("button", { name: "Answer in terminal" })).toBeVisible()
        await vi.advanceTimersByTimeAsync(answeredMs)
        await expect.element(card).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  context("focus after an answer", () => {
    it("goes to the answered line, then to the box once the card has gone", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        await card.getByRole("button", { name: "Yes, proceed" }).click()
        await vi.advanceTimersByTimeAsync(answerMs)
        await expect.element(card.getByText(/Answered\. Waiting for Codex/)).toHaveFocus()
        await vi.advanceTimersByTimeAsync(answeredMs)
        await expect.element(card).not.toBeInTheDocument()
        await expect.element(composer(chat)).toHaveFocus()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  context("when denied with words", () => {
    it("sends them to the agent as its next prompt", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await card.getByRole("button", { name: /^No, and tell Codex/ }).click()
      const field = card.getByRole("textbox", { name: "No, and tell Codex what to do differently" })
      await expect.element(field).toHaveFocus()
      await userEvent.type(field, "Run only the unit tests")
      await userEvent.keyboard("{Enter}")
      await expect.element(card).not.toBeInTheDocument()
      await expect.element(conversation(chat).getByText("Run only the unit tests")).toBeVisible()
    })
  })

  context("when it is a plan", () => {
    it("is rejected with feedback typed into the dialog", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout implementation")
      const card = requestCard(chat, /^Plan to review/)
      await card.getByRole("button", { name: /^No, and tell Claude/ }).click()
      await userEvent.type(
        card.getByRole("textbox", { name: "No, and tell Claude what to change" }),
        "Skip the payment step",
      )
      await card.getByRole("button", { name: "Send answer" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(conversation(chat).getByText(/I'll revise the plan: Skip the payment step/), {
          timeout: 5000,
        })
        .toBeVisible()
    })
  })

  context("with questions", () => {
    it("takes several answers, some picked, some in the person's words, in one submit", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: ask_question/)
      await expect.element(card.getByText("0 of 2 answered")).toBeInTheDocument()
      await expect.element(card.getByText("Fast, runs in a few seconds")).toBeVisible()
      const checks = card.getByRole("group", { name: /Which checks/ })
      await checks.getByText("Unit tests").click()
      await checks.getByText("Lint").click()
      await userEvent.type(
        card.getByRole("textbox", { name: /^Other: Which checks/ }),
        "Bundle size",
      )
      await card.getByRole("tab", { name: /Submit/ }).click()
      const submit = card.getByRole("button", { name: "Submit answers" })
      await expect.element(submit).toHaveAttribute("aria-disabled", "true")
      await card.getByRole("tab", { name: /Note|logging/i }).click()
      const note = card.getByRole("radiogroup", { name: /Where should the logging note live/ })
      await note.getByText("The README").click()
      await expect.element(card.getByText("2 of 2 answered")).toBeInTheDocument()
      await expect.element(submit).not.toHaveAttribute("aria-disabled")
      await submit.click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(
          chat.getByText("Noted: Unit tests, Lint, Bundle size; The README", { exact: false }),
          {
            timeout: 5000,
          },
        )
        .toBeVisible()
    })

    it("takes the whole dialog from the keyboard, picking only what it is told to", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: ask_question/)
      const unit = card.getByRole("checkbox", { name: "Unit tests" })
      unit.element().focus()
      await userEvent.keyboard(" ")
      await expect.element(unit).toBeChecked()
      await userEvent.keyboard("{ArrowDown}")
      const types = card.getByRole("checkbox", { name: "Type check" })
      await expect.element(types).toHaveFocus()
      await expect.element(types).not.toBeChecked()
      await userEvent.keyboard("{Enter}")
      const note = card.getByRole("radiogroup", { name: /Where should the logging note live/ })
      const first = note.getByRole("radio", { name: "notes/logging.md" })
      const readme = note.getByRole("radio", { name: "The README" })
      await expect.element(first).toHaveFocus()
      await userEvent.keyboard("{ArrowDown}")
      await expect.element(readme).toHaveFocus()
      await expect.element(first).not.toBeChecked()
      await expect.element(readme).not.toBeChecked()
      await userEvent.keyboard("{ArrowLeft}")
      await expect.element(card.getByRole("checkbox", { name: "Type check" })).toHaveFocus()
      await userEvent.keyboard("{ArrowRight}")
      await expect.element(readme).toHaveFocus()
      await expect.element(readme).not.toBeChecked()
      await userEvent.keyboard("{Enter}")
      await expect.element(card.getByRole("button", { name: "Submit answers" })).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(chat.getByText("Noted: Unit tests; The README", { exact: false }), {
          timeout: 5000,
        })
        .toBeVisible()
    })

    it("lets the person set the questions aside and chat about them in the box", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: ask_question/)
      await card.getByRole("button", { name: "Chat about this" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect.element(composer(chat)).toHaveFocus()
      await userEvent.keyboard("What does each check cost{Enter}")
      await expect.element(conversation(chat).getByText("What does each check cost")).toBeVisible()
    })

    it("takes the person's own words instead of an option with Enter", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: ask_question/)
      await card.getByText("Lint").click()
      await card.getByRole("tab", { name: /Note|logging/i }).click()
      const note = card.getByRole("radiogroup", { name: /Where should the logging note live/ })
      await note.getByText("The README").click()
      await card.getByRole("tab", { name: /Note|logging/i }).click()
      await userEvent.type(
        card.getByRole("textbox", { name: /^Other: Where should/ }),
        "In the wiki",
      )
      await expect.element(note.getByRole("radio", { name: "The README" })).not.toBeChecked()
      await userEvent.keyboard("{Enter}")
      await userEvent.keyboard("{Enter}")
      await expect.element(card).not.toBeInTheDocument()
    })
  })

  context("when it is a form an MCP server asks for", () => {
    it("is accepted once its required fields are filled, with typed values", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: mcp_deploy/)
      const accept = card.getByRole("button", { name: "Submit" })
      await expect.element(card.getByText("Configure the deploy target").first()).toBeVisible()
      await expect.element(accept).toHaveAttribute("aria-disabled", "true")
      await userEvent.type(card.getByRole("textbox", { name: /^Target name/ }), "api")
      await expect.element(accept).toHaveAttribute("aria-disabled", "true")
      await card
        .getByRole("radiogroup", { name: /^Environment/ })
        .getByText("production")
        .click()
      await card.getByRole("spinbutton", { name: /^Replicas/ }).fill("3")
      await card
        .getByRole("radiogroup", { name: /^Dry run first/ })
        .getByText("Yes")
        .click()
      await expect.element(accept).not.toHaveAttribute("aria-disabled")
      await accept.click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(chat.getByText("Deploying api to production.", { exact: false }), {
          timeout: 5000,
        })
        .toBeVisible()
    })

    it("takes a pick back with Space, leaving a yes or no unsaid", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: mcp_deploy/)
      const yes = card.getByRole("radiogroup", { name: /^Dry run first/ }).getByRole("radio", {
        name: "Yes",
      })
      await card
        .getByRole("radiogroup", { name: /^Dry run first/ })
        .getByText("Yes")
        .click()
      await expect.element(yes).toBeChecked()
      await userEvent.keyboard(" ")
      await expect.element(yes).not.toBeChecked()
    })

    it("is declined without filling anything", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question: mcp_deploy/)
      await card.getByRole("button", { name: "Decline" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(chat.getByText("I won't deploy", { exact: false }), { timeout: 5000 })
        .toBeVisible()
    })
  })

  context("when the chat can't read it", () => {
    it("shows the dialog's text as it is and leaves the answer to the terminal", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Needs your permission/)
      await expect.element(card.getByText(/can't read this dialog/)).toBeInTheDocument()
      await expect.element(card.getByText("Allow for this session", { exact: false })).toBeVisible()
      await expect.element(card.getByRole("button", { name: "Yes" })).not.toBeInTheDocument()
      await card.getByRole("button", { name: "Answer in terminal" }).click()
      await expect.element(chat).not.toBeInTheDocument()
      await expect.element(commandInput("Runtime")).toHaveFocus()
    })
  })
})

describe("A chat whose agent's record holds parts it can't read", () => {
  const mark = /part of the record the chat can't read/

  it("marks the spot, where the line as written opens", async () => {
    await openChatDemo("/", { gap: true })
    const chat = await openChat("Checkout implementation")
    await chat.getByText(mark).click()
    await expect.element(chat.getByText('{"type":"hologram"}')).toBeVisible()
  })

  it("says nothing while its conversation holds nothing unread", async () => {
    await openChatDemo()
    const chat = await openChat("Checkout implementation")
    await expect.element(conversation(chat)).toBeVisible()
    await expectStaysAbsent(chat.getByText(mark))
  })
})

describe("The chat in other views", () => {
  it("fills a Grid window and keeps the composer usable", async () => {
    await openChatDemo("/projects/storefront/sessions/initial/grid")
    const chat = chatOf("Build")
    await expect.element(chat).toBeVisible()
    await expect.element(composer(chat)).toBeVisible()
  })
})
