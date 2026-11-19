import { onTestFinished } from "vitest"
import { page, userEvent } from "vitest/browser"

import { chatOf, composer, openChat, requestCard } from "../support/chat"
import { openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { switchProject } from "../support/sessions"
import { chooseView, openWorkspace, terminal } from "../support/workspace"
import { describe, expect, it } from "../test"

// The hidden xterm still fits and tells the agent its real size. Count its renderer's
// rows, rather than infer them from a CSS height or the chat's layout.
const rowsOf = (name: string): number =>
  terminal(name).element().querySelector(".xterm-rows")?.children.length ?? 0

const screenOf = (name: string): HTMLElement =>
  terminal(name).element().querySelector<HTMLElement>(".chat-terminal")!

// Each case opens the whole app and switches it five times: Grid, Focus, Grid, then a chat
// turned off from Preferences. That takes 2.5 s here, but 16 to 26 s on a slow macOS runner,
// where an attempt a little slower than its neighbours ran out the 30 s default.
const slowRunner = { timeout: 60_000 }

describe("The terminal behind a chat", slowRunner, () => {
  for (const { name, fontSize, harness, project } of [
    { name: "Checkout implementation", fontSize: 12, harness: "Claude Code", project: "docs-site" },
    { name: "Checkout implementation", fontSize: 15, harness: "Claude Code", project: "docs-site" },
    { name: "Checkout review", fontSize: 13, harness: "Codex" },
    { name: "Runtime", fontSize: 13, harness: "Antigravity" },
  ])
    it(`keeps ${harness}'s screen whole in a short Grid tile at ${fontSize}px and restores the visible fit`, async () => {
      onTestFinished(() => page.viewport(1440, 900))
      await page.viewport(1000, 650)
      localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView: true, fontSize }))
      await openWorkspace("/?demo=agents")
      await chooseView("Grid")
      if (project) await switchProject(project)
      const chat = await openChat(name)
      const card = requestCard(chat, /^Has a question/)
      if (project) await expect.element(card).toBeVisible()
      await expect.poll(() => rowsOf(name)).toBeGreaterThanOrEqual(40)

      const box = terminal(name).element().getBoundingClientRect()
      const screen = screenOf(name)
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
      expect(screen.getBoundingClientRect().height).toBeGreaterThan(box.height)
      expect(screen.getBoundingClientRect().width).toBe(
        screen.parentElement!.getBoundingClientRect().width,
      )
      expect(getComputedStyle(screen).position).toBe("absolute")
      expect(getComputedStyle(screen.parentElement!).overflow).toBe("hidden")
      expect(screen.parentElement!.getBoundingClientRect().height).toBeLessThan(box.height)
      await expect.element(composer(chat)).toBeVisible()

      await chooseView("Focus")
      if (project) await expect.element(card).toBeVisible()
      await expect.poll(() => rowsOf(name)).toBeGreaterThanOrEqual(40)
      await chooseView("Grid")
      if (project) await expect.element(card).toBeVisible()
      await expect.poll(() => rowsOf(name)).toBeGreaterThanOrEqual(40)

      await openPreferencesOn("Appearance")
      await preferencesDialog().getByRole("radio", { name: "Terminal" }).click()
      await userEvent.keyboard("{Escape}")
      await expect.element(chatOf(name)).not.toBeInTheDocument()
      await expect.poll(() => rowsOf(name)).toBeLessThan(40)
      expect(getComputedStyle(screenOf(name)).position).toBe("static")
      expect(screenOf(name).getBoundingClientRect().height).toBeLessThanOrEqual(box.height)
    })
})
