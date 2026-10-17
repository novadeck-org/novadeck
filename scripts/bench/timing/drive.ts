import { chromium, type CDPSession, type Page } from "playwright"

import type { Steady, Switch } from "./report.ts"
import type { Running } from "./stack.ts"

// The scenario, as the measurement behind #206 ran it: 13 terminals in one session, the
// first 5 running the fake agent and the rest idle shells; Grid, then Focus, so every
// screen has been opened once; a steady window in each with every agent busy, Focus on
// agent 1; then switches between terminals in Focus, busy and idle, kept and not, timed
// from the press to the first frame after the target's screen is in the page, laid out.

export const scenario = {
  terminals: 13,
  agents: 5,
  focusedInSteady: 1,
  warmMs: 5000,
  windowMs: 15_000,
  switchPasses: 2,
  // Each revisit comes within Focus's last 4 shown, so it lands on a kept window, mounted
  // and hidden; the rest land on ones Focus no longer keeps, which mount again. None starts on agent 1, which the steady window leaves shown.
  switchTargets: [8, 3, 8, 12, 5, 12, 9, 2, 9, 13, 4, 13, 7, 1, 7],
  viewport: { width: 1440, height: 900 },
} as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What the page keeps for the run on `window`. Functions run in the page are sent there as
// source, so each reaches it through a cast of its own rather than a helper here.
type Probe = {
  benchTiming: { longTasks: number[]; frames: number[]; recording: boolean }
  benchSwitch: { clicked: number; painted: number | undefined }
}

// In the page before the app loads: long tasks as they happen, and each animation frame's
// time while a window records.
const probe = () => {
  const timing: Probe["benchTiming"] = { longTasks: [], frames: [], recording: false }
  ;(window as unknown as Probe).benchTiming = timing
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) timing.longTasks.push(entry.duration)
    }).observe({ type: "longtask" })
  } catch {
    // No long tasks to observe: the window reports none.
  }
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Sent to the page as source.
  const loop = (time: number) => {
    if (timing.recording) timing.frames.push(time)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

const rows = "[data-terminal-tab-id]"

// The radio's input sits under its label, which takes the click.
const layout = (page: Page, name: "Grid" | "Focus") =>
  page
    .getByRole("radiogroup", { name: "Workspace layout" })
    .getByText(name, { exact: true })
    .click()

/** The phase of terminal `n`'s row (1-based), or null before it's there. */
const phase = (page: Page, n: number) =>
  page.evaluate(
    ([selector, index]) =>
      document.querySelectorAll(selector)[index]?.getAttribute("data-terminal-phase") ?? null,
    [rows, n - 1] as const,
  )

/** Whether a visible screen shows `text`. */
const shown = (page: Page, text: string) =>
  page.evaluate(
    (wanted) =>
      [...document.querySelectorAll(".xterm")].some((screen) => {
        const box = screen.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && (screen.textContent ?? "").includes(wanted)
      }),
    text,
  )

const until = async (check: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Looks again until it holds.
    if (await check()) return true
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(250)
  }
  return false
}

/** Types `command` into the visible screen. */
const type = async (page: Page, command: string) => {
  const center = await page.evaluate(() => {
    const screen = [...document.querySelectorAll(".xterm")].find((each) => {
      const box = each.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
    const box = screen?.getBoundingClientRect()
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined
  })
  if (!center) throw new Error("no screen to type into")
  await page.mouse.click(center.x, center.y)
  await page.keyboard.type(command)
  await page.keyboard.press("Enter")
}

/** Where terminal `n`'s row is, scrolled into view first. */
const row = async (page: Page, n: number) => {
  await page.evaluate(
    ([selector, index]) =>
      document.querySelectorAll(selector)[index]?.scrollIntoView({ block: "nearest" }),
    [rows, n - 1] as const,
  )
  await sleep(150)
  return page.evaluate(
    ([selector, index]) => {
      const box = document.querySelectorAll(selector)[index]?.getBoundingClientRect()
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined
    },
    [rows, n - 1] as const,
  )
}

/** Opens 13 terminals; the first 5 start the fake agent, the rest print a mark and idle. */
const setUp = async (page: Page, stack: Running) => {
  for (let n = 1; n <= scenario.terminals; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- One terminal after another, as a person opens them.
    await page.getByRole("button", { name: "New terminal" }).first().click()
    // Keys typed while it starts are lost.
    // eslint-disable-next-line no-await-in-loop -- As above.
    const started = await until(async () => {
      const now = await phase(page, n)
      return now !== null && now !== "starting"
    }, 30_000)
    if (!started) throw new Error(`terminal ${n} never started`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(500)
    const agent = n <= scenario.agents
    // eslint-disable-next-line no-await-in-loop -- As above.
    await type(
      page,
      agent ? `clear; ${stack.agent(n)}` : `clear; printf '[T%s] idle shell\\n' ${n}`,
    )
    // eslint-disable-next-line no-await-in-loop -- As above.
    const marked = await until(() => shown(page, `[T${n}]`), 15_000)
    if (!marked) throw new Error(`terminal ${n} never showed its mark`)
  }
}

/** Measures a steady window in `name`, every agent busy, after a warm-up. */
const steady = async (page: Page, cdp: CDPSession, name: Steady["layout"]): Promise<Steady> => {
  await layout(page, name)
  await sleep(scenario.warmMs)
  // The main thread's busy time and the clock it's measured on, from the same reading.
  const reading = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    const value = (key: string) => {
      const found = metrics.find((metric) => metric.name === key)?.value
      // A metric Chromium no longer reports would read as an idle main thread.
      if (found === undefined) throw new Error(`Chromium reported no ${key}`)
      return found
    }
    return { task: value("TaskDuration"), at: value("Timestamp") }
  }
  const longTasks = await page.evaluate(() => {
    const { benchTiming } = window as unknown as Probe
    benchTiming.frames = []
    benchTiming.recording = true
    return benchTiming.longTasks.length
  })
  const before = await reading()
  await sleep(scenario.windowMs)
  const after = await reading()
  const { frames, tasks } = await page.evaluate((from) => {
    const { benchTiming } = window as unknown as Probe
    benchTiming.recording = false
    return { frames: benchTiming.frames, tasks: benchTiming.longTasks.slice(from) }
  }, longTasks)
  return {
    layout: name,
    seconds: after.at - before.at,
    taskSeconds: after.task - before.task,
    frameGaps: frames.slice(1).map((time, index) => time - frames[index]!),
    longTasks: tasks,
  }
}

/**
 * Clicks terminal `target`'s row and times it from the press to the first frame painted
 * after the target's screen is in the page and laid out: the frame callback that finds it
 * posts a message, which arrives once that frame has painted. A kept window is in the page
 * already, so its switch is the time to show it.
 */
const switchTo = async (page: Page, target: number): Promise<Switch> => {
  const where = await row(page, target)
  if (!where) return { target, ms: undefined }
  await page.evaluate((tag) => {
    const timing: Probe["benchSwitch"] = { clicked: 0, painted: undefined }
    ;(window as unknown as Probe).benchSwitch = timing
    const visible = () =>
      [...document.querySelectorAll(".xterm")]
        .filter((screen) => {
          const box = screen.getBoundingClientRect()
          return box.width > 0 && box.height > 0
        })
        .some((screen) => (screen.textContent ?? "").includes(tag))
    // From the press itself, its event's time, so a press waiting behind long tasks counts
    // its wait too.
    const down = (event: Event) => {
      document.removeEventListener("pointerdown", down, true)
      timing.clicked = event.timeStamp
      const step = () => {
        if (visible()) {
          const channel = new MessageChannel()
          channel.port1.addEventListener(
            "message",
            () => {
              timing.painted = performance.now()
            },
            { once: true },
          )
          channel.port1.start()
          channel.port2.postMessage(undefined)
        } else if (performance.now() - timing.clicked < 4000) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
    document.addEventListener("pointerdown", down, true)
  }, `[T${target}]`)
  await page.mouse.click(where.x, where.y)
  const painted = await until(
    () => page.evaluate(() => (window as unknown as Probe).benchSwitch.painted !== undefined),
    4500,
  )
  const ms = painted
    ? await page.evaluate(() => {
        const { clicked, painted: at } = (window as unknown as Probe).benchSwitch
        return (at ?? clicked) - clicked
      })
    : undefined
  await sleep(700)
  return { target, ms }
}

/** Selects terminal `n` by its row, as a person does. */
const select = async (page: Page, n: number) => {
  const where = await row(page, n)
  if (!where) throw new Error(`terminal ${n} has no row`)
  await page.mouse.click(where.x, where.y)
  await sleep(800)
}

/**
 * Runs the scenario in headless Chromium against `stack`, adding what it measures to
 * `measured` as it goes, so a run that fails part way keeps what it got, and telling
 * `launched` the browser's version as soon as it runs.
 */
export const drive = async (
  stack: Running,
  measured: { agentPhases: (string | null)[]; steady: Steady[]; switches: Switch[] },
  launched: (version: string) => void,
): Promise<void> => {
  // Playwright would end the process on SIGINT itself, before main.ts has stopped the stack
  // and written the report; the browser closes as `drive` ends, and on exit regardless.
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  launched(browser.version())
  try {
    const page = await browser.newPage({ viewport: scenario.viewport })
    await page.addInitScript(probe)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    await page.goto(stack.url, { waitUntil: "load" })
    // Booted once it offers either the welcome or a new terminal, as it does once it has
    // connected to the runner.
    const skip = page.getByText("Skip for now")
    await skip
      .or(page.getByRole("button", { name: "New terminal" }))
      .first()
      .waitFor({ timeout: 60_000 })
    if (await skip.isVisible()) await skip.click()
    await layout(page, "Focus")
    await setUp(page, stack)
    for (let seed = 1; seed <= scenario.agents; seed += 1) stack.busy(seed, true)
    const agents = Array.from({ length: scenario.agents }, (_, index) => index + 1)
    const phases = () => Promise.all(agents.map((n) => phase(page, n)))
    await until(async () => (await phases()).every((each) => each === "running"), 15_000)
    measured.agentPhases.push(...(await phases()))
    measured.steady.push(await steady(page, cdp, "Grid"))
    // What a person watching an agent sees, the other four running beside it.
    await layout(page, "Focus")
    await select(page, 1)
    measured.steady.push(await steady(page, cdp, "Focus"))
    for (let pass = 0; pass < scenario.switchPasses; pass += 1)
      for (const target of scenario.switchTargets)
        // eslint-disable-next-line no-await-in-loop -- One switch after another.
        measured.switches.push(await switchTo(page, target))
    for (let seed = 1; seed <= scenario.agents; seed += 1) stack.busy(seed, false)
  } finally {
    await browser.close()
  }
}
