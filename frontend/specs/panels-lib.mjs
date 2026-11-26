import { chromium } from "playwright"
export const OUT = "/home/mzpk/Workspace/novadeck/voice-audit/shots/panels/"
export const S = "/tmp/claude-1000/-home-mzpk-Workspace-novadeck/7a05314e-42a0-45a3-93c3-c458ddc89acf/scratchpad/panels/"
export const start = async (url = "http://127.0.0.1:5212/", init) => {
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "light" })
  if (init) await p.addInitScript(init)
  await p.goto(url)
  await p.waitForTimeout(3500)
  return { b, p }
}
export const openDebug = async (p) => {
  const h = p.locator(".debug-handle")
  if ((await h.getAttribute("aria-label")) === "Open the debug panel") await h.click()
  await p.waitForTimeout(300)
}
export const closeDebug = async (p) => {
  const h = p.locator(".debug-handle")
  if ((await h.getAttribute("aria-label")) === "Close the debug panel") await h.click()
  await p.waitForTimeout(400)
}
export const act = async (p, label, group) => {
  await openDebug(p)
  const panel = p.getByRole("region", { name: "Debug panel" }).or(p.locator(".debug-panel"))
  await p.getByLabel("Find a state").fill(label)
  await p.waitForTimeout(300)
  const body = p.locator(".debug-panel-body")
  const btns = body.locator("button").filter({ hasText: label })
  const n = await btns.count()
  const texts = await btns.allTextContents()
  // pick the one that is not a group header
  let target = null
  for (let i = 0; i < n; i++) {
    const cls = (await btns.nth(i).getAttribute("class")) || ""
    if (!cls.includes("debug-group")) { target = btns.nth(i); break }
  }
  if (!target) {
    // expand group
    if (group) await body.locator("button.debug-group").filter({ hasText: group }).first().click()
    else await btns.first().click()
    await p.waitForTimeout(200)
    const again = body.locator("button:not(.debug-group)").filter({ hasText: label })
    target = again.first()
  }
  await target.click()
  await p.waitForTimeout(500)
  await closeDebug(p)
}
export const dump = async (p) => console.log(await p.evaluate(() => document.body.innerText.slice(0, 3000)))
