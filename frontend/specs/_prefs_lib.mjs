import { chromium } from "playwright"
export const SHOTS = "/home/mzpk/Workspace/novadeck/voice-audit/shots/prefs"
export const start = async () => {
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "light" })
  await p.goto("http://127.0.0.1:5211/")
  await p.waitForTimeout(2500)
  await p.getByRole("button", { name: "No thanks" }).click({ timeout: 2000 }).catch(() => {})
  return { b, p }
}
export const debug = async (p, label) => {
  await p.getByRole("button", { name: "Open the debug panel" }).click()
  await p.getByLabel("Find a state").fill(label)
  await p.waitForTimeout(300)
  await p.locator(".debug-action").filter({ has: p.locator("span.font-medium", { hasText: new RegExp("^" + label.replace(/[()?.]/g, "\\$&") + "$") }) }).first().click()
  await p.waitForTimeout(400)
  const close = p.getByRole("button", { name: "Close the debug panel" })
  if (await close.count()) await close.click()
  await p.waitForTimeout(300)
}
export const prefs = async (p, tab) => {
  if (!(await p.getByRole("tab", { name: "Agents", exact: true }).count())) {
    await p.keyboard.press("Control+Comma"); await p.waitForTimeout(700)
  }
  if (tab) { await p.getByRole("tab", { name: tab, exact: true }).click(); await p.waitForTimeout(400) }
}
// screenshot the preference row/section containing text
export const shotText = async (p, text, name, { up = ".preference-row", pad = 8 } = {}) => {
  const el = p.getByText(text, { exact: false }).first()
  const target = up ? el.locator(`xpath=ancestor-or-self::*[contains(concat(' ',normalize-space(@class),' '),' ${up.slice(1)} ')][1]`) : el
  const t = (await target.count()) ? target : el
  await t.scrollIntoViewIfNeeded()
  const box = await t.boundingBox()
  await p.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log("shot", name)
}
export const shotBox = async (p, loc, name, pad = 8) => {
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  await p.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
  console.log("shot", name)
}
