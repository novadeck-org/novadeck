import { chatOf, composer, conversation, openChat, openChatDemo } from "../support/chat"
import { chooseFromIconMenu, companionPane, taskbarIcon } from "../support/companions"
import { describe, expect, it } from "../test"

// The agents demo's Claude Code in Build has two background shells: a dev server that runs
// and a database that failed with exit code 1, and the chat pins a line for each.
const openShells = async () => {
  await openChatDemo()
  const chat = await openChat("Build")
  const lines = chat.getByRole("group", { name: "Background shells" })
  return { chat, failed: lines.getByRole("button", { name: /^Show the output of docker compose/ }) }
}

const failedRow = (pane: ReturnType<typeof companionPane>) =>
  pane.getByRole("button", { name: /docker compose up postgres/, expanded: true })

const draft = (chat: ReturnType<typeof chatOf>): string =>
  (composer(chat).element() as HTMLTextAreaElement).value

describe("A terminal's background shells", () => {
  it("open the Shells item at the shell whose line in the chat was clicked, and again after it was closed", async () => {
    const { failed } = await openShells()
    await expect
      .element(failed)
      .toHaveAccessibleName("Show the output of docker compose up postgres, exited 1")

    await failed.click()
    const pane = companionPane("Build")
    await expect.element(failedRow(pane)).toBeVisible()
    const log = pane.getByRole("log", { name: "Output of docker compose up postgres" })
    await expect.element(log).toBeVisible()
    expect(log.element().textContent).toContain("port is already allocated")

    // The person closes it from the taskbar; the chat's line brings it back at that shell.
    await chooseFromIconMenu("Build", "Shells", "Close")
    await expect.element(taskbarIcon("Build", "Shells")).not.toBeInTheDocument()
    await failed.click()
    await expect.element(failedRow(companionPane("Build"))).toBeVisible()
  })

  it("draft what a failed one printed into the chat's box for the person to look over, never sent", async () => {
    const { chat, failed } = await openShells()
    await failed.click()
    const pane = companionPane("Build")
    await pane.getByRole("button", { name: "Tell Claude" }).click()
    await expect.element(pane.getByRole("button", { name: "Drafted" })).toBeVisible()
    expect(draft(chat)).toContain("`docker compose up postgres` exited 1.")
    expect(draft(chat)).toContain("port is already allocated")

    // Asking again adds nothing, and nothing went to the agent.
    await pane.getByRole("button", { name: "Drafted" }).click()
    expect(draft(chat).split("exited 1.")).toHaveLength(2)
    expect(conversation(chat).element().textContent).not.toContain("exited 1.")
  })
})
