import { describe as context, describe, expect, it } from "vitest"
import { userEvent } from "vitest/browser"

import {
  chatToggle,
  composer,
  conversation,
  openChat,
  openChatDemo,
  requestCard,
} from "./support/chat"
import { chooseView, commandInput, terminal, terminalTab } from "./support/workspace"

describe("A terminal's chat toggle", () => {
  it("shows for a terminal running an agent and not for another", async () => {
    await openChatDemo()
    await terminalTab("Checkout implementation").click()
    await expect.element(chatToggle("Checkout implementation")).toBeVisible()
    await terminalTab("Dev server").click()
    await expect.element(chatToggle("Dev server")).not.toBeInTheDocument()
  })

  it("switches to the chat and back to the terminal, which keeps its output", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await expect.element(chat.getByText("It passes now.", { exact: false })).toBeVisible()
    await expect.element(chatToggle("Build")).toHaveAttribute("aria-pressed", "true")
    await chatToggle("Build").click()
    await expect.element(chat).not.toBeInTheDocument()
    await expect.element(chatToggle("Build")).toHaveAttribute("aria-pressed", "false")
    await expect.element(commandInput("Build")).toBeVisible()
    await expect
      .element(terminal("Build").getByText("Added the order summary", { exact: false }))
      .toBeVisible()
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

  it("opens a tool call to its input and result", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const row = chat.getByRole("button", { name: /^Edited .*total\.ts/ })
    await expect.element(row).toHaveAttribute("aria-expanded", "false")
    await row.click()
    await expect.element(row).toHaveAttribute("aria-expanded", "true")
    await expect
      .element(chat.getByRole("region", { name: "Result" }).getByText(/has been updated/))
      .toBeVisible()
  })

  it("names another agent's message by its author", async () => {
    await openChatDemo()
    const chat = await openChat("Checkout review")
    await expect
      .element(chat.getByRole("article", { name: "Message from /root/explorer_1" }))
      .toBeVisible()
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
    await expect.element(chat.getByText(/Runs in Claude's shell/)).toBeVisible()
    await expect.element(chat.getByRole("button", { name: "Send" })).toBeDisabled()
    await userEvent.keyboard("ls -la{Enter}")
    await expect.element(composer(chat)).toHaveValue("")
    await expect.element(conversation(chat).getByText("!ls -la")).toBeVisible()
    await expect.element(conversation(chat).getByText("Ran", { exact: true }).last()).toBeVisible()
  })

  it("keeps Shift+Enter for a new line", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    await userEvent.type(composer(chat), "one")
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}")
    await userEvent.type(composer(chat), "two")
    await expect.element(composer(chat)).toHaveValue("one\ntwo")
  })

  it("says why a prompt didn't go and keeps what was typed", async () => {
    await openChatDemo()
    // Claude Code in Tests still works in the background.
    const chat = await openChat("Tests")
    await userEvent.type(composer(chat), "More please")
    await userEvent.keyboard("{Enter}")
    await expect.element(chat.getByRole("alert").getByText(/still working/)).toBeVisible()
    await expect.element(composer(chat)).toHaveValue("More please")
  })
})

describe("Reading the chat", () => {
  it("leaves focus on a tool row the person clicked", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const row = chat.getByRole("button", { name: /^Edited .*total\.ts/ })
    await row.click()
    // The workspace would send typing back to the composer a frame after a click.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect.element(row).toHaveFocus()
  })

  it("lets the person select text, which stays selected", async () => {
    await openChatDemo()
    const chat = await openChat("Build")
    const reply = conversation(chat).getByText("It passes now.", { exact: false })
    await reply.click({ clickCount: 3 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(window.getSelection()?.toString()).toContain("It passes now.")
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
    await expect.element(chat.getByRole("button", { name: /^Ran / }).first()).toBeVisible()
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
  context("shown as a card", () => {
    it("names what it asks and its answers, and answering in the terminal goes there", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await expect.element(card.getByText("pnpm test --filter checkout").first()).toBeVisible()
      await expect
        .element(card.getByLabelText("What it asks"))
        .toHaveTextContent("pnpm test --filter checkout")
      await expect.element(card.getByRole("button", { name: "Yes, proceed" })).toBeVisible()
      await card.getByRole("button", { name: "Answer in terminal" }).click()
      await expect.element(chat).not.toBeInTheDocument()
      await expect.element(chatToggle("Checkout review")).toHaveAttribute("aria-pressed", "false")
      await expect.element(commandInput("Checkout review")).toHaveFocus()
    })
  })

  context("approved from the chat", () => {
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
      await card.getByRole("button", { name: "Yes, proceed" }).click()
      await expect.element(card.getByText(/Answered\. Waiting for Codex/)).toBeVisible()
      await expect
        .element(card.getByRole("button", { name: "Yes, proceed" }))
        .not.toBeInTheDocument()
      await expect.element(card.getByRole("button", { name: "Answer in terminal" })).toBeVisible()
      await expect.element(card).not.toBeInTheDocument()
    })
  })

  context("focus after an answer", () => {
    it("goes to the answered line, then to the box once the card has gone", async () => {
      await openChatDemo()
      const chat = await openChat("Checkout review")
      const card = requestCard(chat, /^Needs your permission/)
      await card.getByRole("button", { name: "Yes, proceed" }).click()
      await expect.element(card.getByText(/Answered\. Waiting for Codex/)).toHaveFocus()
      await expect.element(card).not.toBeInTheDocument()
      await expect.element(composer(chat)).toHaveFocus()
    })
  })

  context("denied with words", () => {
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

  context("a plan", () => {
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
      const card = requestCard(chat, /^Has a question/)
      const submit = card.getByRole("button", { name: "Submit" })
      await expect.element(submit).toBeDisabled()
      await expect.element(card.getByText("0 of 2 answered")).toBeVisible()
      await expect.element(card.getByText("Fast, runs in a few seconds")).toBeVisible()
      const checks = card.getByRole("group", { name: /Which checks/ })
      await checks.getByRole("checkbox", { name: "Unit tests" }).click()
      await checks.getByRole("checkbox", { name: "Lint" }).click()
      await userEvent.type(
        card.getByRole("textbox", { name: /^Other: Which checks/ }),
        "Bundle size",
      )
      await expect.element(submit).toBeDisabled()
      const note = card.getByRole("radiogroup", { name: /Where should the logging note live/ })
      await note.getByRole("radio", { name: "The README" }).click()
      await expect.element(card.getByText("2 of 2 answered")).toBeVisible()
      await expect.element(submit).toBeEnabled()
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

    it("lets the person set the questions aside and chat about them in the box", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question/)
      await card.getByRole("button", { name: "Chat about this" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect.element(composer(chat)).toHaveFocus()
      await userEvent.keyboard("What does each check cost{Enter}")
      await expect.element(conversation(chat).getByText("What does each check cost")).toBeVisible()
    })

    it("takes the person's own words instead of an option with Enter", async () => {
      await openChatDemo()
      const chat = await openChat("Runtime")
      const card = requestCard(chat, /^Has a question/)
      const note = card.getByRole("radiogroup", { name: /Where should the logging note live/ })
      await card.getByRole("checkbox", { name: "Lint" }).click()
      await note.getByRole("radio", { name: "The README" }).click()
      await userEvent.type(
        card.getByRole("textbox", { name: /^Other: Where should/ }),
        "In the wiki",
      )
      await expect.element(note.getByRole("radio", { name: "The README" })).not.toBeChecked()
      await userEvent.keyboard("{Enter}")
      await expect.element(card).not.toBeInTheDocument()
    })
  })

  context("a form an MCP server asks for", () => {
    it("is accepted once its required fields are filled, with typed values", async () => {
      await openChatDemo()
      const chat = await openChat("Build")
      const card = requestCard(chat, /^Has a question/)
      const accept = card.getByRole("button", { name: "Accept" })
      await expect.element(card.getByText("Configure the deploy target").first()).toBeVisible()
      await expect.element(accept).toBeDisabled()
      await userEvent.type(card.getByRole("textbox", { name: "Target name" }), "api")
      await expect.element(accept).toBeDisabled()
      await card.getByRole("combobox", { name: "Environment" }).selectOptions("production")
      await card.getByRole("spinbutton", { name: "Replicas" }).fill("3")
      await card.getByRole("combobox", { name: "Dry run first" }).selectOptions("Yes")
      await expect.element(accept).toBeEnabled()
      await accept.click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(chat.getByText("Deploying api to production.", { exact: false }), {
          timeout: 5000,
        })
        .toBeVisible()
    })

    it("is declined without filling anything", async () => {
      await openChatDemo()
      const chat = await openChat("Build")
      const card = requestCard(chat, /^Has a question/)
      await card.getByRole("button", { name: "Decline" }).click()
      await expect.element(card).not.toBeInTheDocument()
      await expect
        .element(chat.getByText("I won't deploy", { exact: false }), { timeout: 5000 })
        .toBeVisible()
    })
  })

  context("the chat can't read", () => {
    it("shows the dialog's text as it is and leaves the answer to the terminal", async () => {
      await openChatDemo()
      const chat = await openChat("Tests")
      const card = requestCard(chat, /^Needs your permission/)
      await expect.element(card.getByText(/can't read this dialog/)).toBeVisible()
      await expect.element(card.getByText("Allow for this session", { exact: false })).toBeVisible()
      await expect.element(card.getByRole("button", { name: "Yes" })).not.toBeInTheDocument()
      await card.getByRole("button", { name: "Answer in terminal" }).click()
      await expect.element(chat).not.toBeInTheDocument()
      await expect.element(commandInput("Tests")).toHaveFocus()
    })
  })
})

describe("The chat in other views", () => {
  it("fills a Grid window and keeps the composer usable", async () => {
    await openChatDemo("/projects/storefront/sessions/initial/grid")
    await chatToggle("Build").click()
    const chat = terminal("Build").getByRole("region", { name: "Build chat" })
    await expect.element(chat).toBeVisible()
    await expect.element(composer(chat)).toBeVisible()
  })
})
