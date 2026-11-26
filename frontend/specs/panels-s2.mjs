import { start, act, openDebug, closeDebug, OUT, S } from "./panels-lib.mjs"
const { b, p } = await start()
await openDebug(p)
await p.locator(".segment", { hasText: "plain" }).click()
await p.waitForTimeout(3000)
await closeDebug(p)
for (const [name, file] of [["Inbox", "02-inbox-empty-idle"], ["Worktrees", "09-worktrees-empty"], ["History", "history-plain"]]) {
  await p.getByRole("button", { name, exact: true }).first().click()
  await p.waitForTimeout(800)
  await p.screenshot({ path: OUT + file + ".png", clip: { x: 0, y: 60, width: 520, height: 400 } })
}
// New session -> empty history?
await p.getByRole("button", { name: "Sessions", exact: true }).first().click()
await p.waitForTimeout(400)
await p.getByRole("button", { name: "New session" }).click()
await p.waitForTimeout(1500)
await p.getByRole("button", { name: "History", exact: true }).first().click()
await p.waitForTimeout(800)
await p.screenshot({ path: S + "history-new.png", clip: { x: 0, y: 60, width: 520, height: 400 } })
await b.close()
