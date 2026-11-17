import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { chromium, type Browser, type CDPSession, type Page } from "playwright"

import { windowFrames } from "../profile/trace.ts"
import { readTrace, record, type Cdp, type TraceConfig } from "../profile/tracing.ts"
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What the page keeps for the run on `window`. Functions run in the page are sent there as
// source, so each reaches it through a cast of its own rather than a helper here.
export type Probe = {
  benchTiming: { longTasks: number[] }
  benchSwitch: { clicked: number; painted: number | undefined }
  /** The ids of the terminals the run opened, in the order it opened them (see `setUp`). */
  benchTerminals?: string[]
}

// In the page, before the app loads or once it has: long tasks as they happen. It counts no
// frames: a page that always has an animation frame requested makes Chromium run a full
// main-thread frame (style, layout, pre-paint, commit) at every vsync even with nothing to
// draw, which would load the very thread the windows measure. Frames are read from a trace
// of each window instead (see `steady`).
export const probe = (): void => {
  const timing: Probe["benchTiming"] = { longTasks: [] }
  ;(window as unknown as Probe).benchTiming = timing
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) timing.longTasks.push(entry.duration)
    }).observe({ type: "longtask" })
  } catch {
    // No long tasks to observe: the window reports none.
  }
}

const rows = "[data-terminal-tab-id]"

// Where a terminal's row is in the list isn't where it was opened: the list shows the newest
// first, and may order its rows otherwise again. So `setUp` keeps each terminal's id as it
// opens it, and every other step finds terminal `n`'s row by its id, in the page.

// The radio's input sits under its label, which takes the click.
export const layout = (page: Page, name: "Grid" | "Focus") =>
  page
    .getByRole("radiogroup", { name: "Workspace layout" })
    .getByText(name, { exact: true })
    .click()

/** The phase of terminal `n`'s row (1-based), or null before it's there. */
export const phase = (page: Page, n: number) =>
  page.evaluate(
    ([selector, index]) => {
      const id = (window as unknown as Probe).benchTerminals?.[index]
      return (
        [...document.querySelectorAll(selector)]
          .find((each) => each.getAttribute("data-terminal-tab-id") === id)
          ?.getAttribute("data-terminal-phase") ?? null
      )
    },
    [rows, n - 1] as const,
  )

// A screen's text is its rows' in the page, as xterm's DOM renderer draws them. A renderer
// that draws on a canvas, as the WebGL renderer does, has none there, so the profile's builds
// leave a `profileText` on the screen's host that reads the rows it shows from the buffer
// instead (see ../profile/patches.ts).

/** Whether a visible screen shows `text`. */
const shown = (page: Page, text: string) =>
  page.evaluate(
    (wanted) =>
      [...document.querySelectorAll(".xterm")].some((screen) => {
        const box = screen.getBoundingClientRect()
        const read = (screen.parentElement as { profileText?: () => string } | null)?.profileText
        return (
          box.width > 0 && box.height > 0 && (read?.() ?? screen.textContent ?? "").includes(wanted)
        )
      }),
    text,
  )

export const until = async (check: () => Promise<boolean>, ms: number): Promise<boolean> => {
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
    ([selector, index]) => {
      const id = (window as unknown as Probe).benchTerminals?.[index]
      ;[...document.querySelectorAll(selector)]
        .find((each) => each.getAttribute("data-terminal-tab-id") === id)
        ?.scrollIntoView({ block: "nearest" })
    },
    [rows, n - 1] as const,
  )
  await sleep(150)
  return page.evaluate(
    ([selector, index]) => {
      const id = (window as unknown as Probe).benchTerminals?.[index]
      const box = [...document.querySelectorAll(selector)]
        .find((each) => each.getAttribute("data-terminal-tab-id") === id)
        ?.getBoundingClientRect()
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined
    },
    [rows, n - 1] as const,
  )
}

/** Remembers the id of the row that has appeared since the last, as terminal `n`'s. */
const claim = (page: Page, selector: string, n: number): Promise<boolean> =>
  page.evaluate(
    ([rowsSelector, index]) => {
      const kept = window as unknown as Probe
      const known = (kept.benchTerminals ??= [])
      const fresh = [...document.querySelectorAll(rowsSelector)]
        .map((each) => each.getAttribute("data-terminal-tab-id") ?? "")
        .find((id) => id !== "" && !known.includes(id))
      if (fresh === undefined) return false
      known[index] = fresh
      return true
    },
    [selector, n - 1] as const,
  )

/**
 * The marks, `[T<n>]`, of the screens in view: those at least half inside the window, each
 * read as `shown` reads one. What a window shows is what it measures, so each steady window
 * records it, and the scenario fails where it isn't the agents (see `scenarioFailures`).
 */
export const marksInView = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const marks = new Set<number>()
    for (const screen of document.querySelectorAll(".xterm")) {
      const box = screen.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) continue
      const inside = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0)
      const high = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)
      if (inside < box.width / 2 || high < box.height / 2) continue
      const read = (screen.parentElement as { profileText?: () => string } | null)?.profileText
      for (const found of (read?.() ?? screen.textContent ?? "").matchAll(/\[T(\d+)\]/g))
        marks.add(Number(found[1]))
    }
    return [...marks].toSorted((a, b) => a - b)
  })

/** The command an idle terminal runs: it prints terminal `n`'s mark. */
export const idleShell = (n: number): string => `printf '[T%s] idle shell\\n' ${n}`

/**
 * Opens `terminals` terminals, one after another, each running `command(n)` once its
 * shell has started, and waits for each to show its mark, `[T<n>]`. The last terminal is
 * opened first and terminal 1 last: the list, and so Grid, shows the newest first, so the
 * first terminals, which the scenario makes the agents, are the ones in view.
 */
export const setUp = async (
  page: Page,
  terminals: number,
  command: (n: number) => string,
): Promise<void> => {
  for (let n = terminals; n >= 1; n -= 1) {
    // eslint-disable-next-line no-await-in-loop -- One terminal after another, as a person opens them.
    await page.getByRole("button", { name: "New terminal" }).first().click()
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (!(await until(() => claim(page, rows, n), 30_000)))
      throw new Error(`terminal ${n} never showed a row`)
    // Keys typed while it starts are lost.
    // eslint-disable-next-line no-await-in-loop -- As above.
    const started = await until(async () => {
      const now = await phase(page, n)
      return now !== null && now !== "starting"
    }, 30_000)
    if (!started) throw new Error(`terminal ${n} never started`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(500)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await type(page, `clear; ${command(n)}`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    const marked = await until(() => shown(page, `[T${n}]`), 15_000)
    if (!marked) throw new Error(`terminal ${n} never showed its mark`)
  }
}

/** Starts recording long tasks; returns where the long tasks recorded so far end. */
export const startRecording = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as Probe).benchTiming.longTasks.length)

/** Stops recording: the long tasks since `from`. */
export const stopRecording = (page: Page, from: number): Promise<{ longTasks: number[] }> =>
  page.evaluate(
    (start) => ({ longTasks: (window as unknown as Probe).benchTiming.longTasks.slice(start) }),
    from,
  )

// What a window's trace records: the page's marks, and the frames the compositor asks of the
// main thread and the main thread's answers. Nothing else, so recording it costs the window little.
const frameTrace: TraceConfig = {
  traceBufferSizeInKb: 64 * 1024,
  includedCategories: [
    "__metadata",
    "blink.user_timing",
    "disabled-by-default-devtools.timeline.frame",
  ],
}

/** A DevTools session of Playwright's, as the trace recording drives it. */
const overSession = (session: CDPSession): Cdp => ({
  send: (method, params) =>
    (session.send as (method: string, params?: object) => Promise<Record<string, unknown>>)(
      method,
      params,
    ),
  next: (event, timeoutMs) =>
    new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        session.off("close", lost)
      }
      const lost = () => {
        settle()
        reject(new Error("the DevTools connection closed"))
      }
      const timer = setTimeout(() => {
        session.off("close", lost)
        reject(new Error(`no ${event} within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      session.once("close", lost)
      ;(
        session.once as (event: string, listener: (params: Record<string, unknown>) => void) => void
      )(event, (params) => {
        settle()
        resolve(params)
      })
    }),
  // The session belongs to the browser, which closes it.
  close: () => {},
})

/**
 * The page's frames in a window, from a trace of it: `profile-start` and `profile-end` marks
 * around `during` give the window.
 */
const framed = async (
  page: Page,
  browserSession: CDPSession,
  during: () => Promise<void>,
): Promise<{ frames: number; slowFrames: number }> => {
  const folder = mkdtempSync(join(tmpdir(), "timing-trace-"))
  let recording: Awaited<ReturnType<typeof record>> | undefined
  try {
    recording = await record(overSession(browserSession), frameTrace)
    await page.evaluate(() => performance.mark("profile-start"))
    await during()
    await page.evaluate(() => performance.mark("profile-end"))
    const path = join(folder, "window.json.gz")
    const stopping = recording
    recording = undefined
    await stopping.stop(path)
    const { count, over33ms } = windowFrames(readTrace(path).traceEvents ?? [])
    return { frames: count, slowFrames: over33ms }
  } finally {
    // A window that threw leaves the browser's tracing started: end it, best effort.
    await recording?.stop(join(folder, "abandoned.json.gz")).catch(() => {})
    rmSync(folder, { recursive: true, force: true })
  }
}

/** Measures a steady window in `name`, every agent busy, after a warm-up. */
const steady = async (
  page: Page,
  cdp: CDPSession,
  browserSession: CDPSession,
  name: Steady["layout"],
): Promise<Steady> => {
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
  const from = await startRecording(page)
  const seenBefore = await marksInView(page)
  let before!: Awaited<ReturnType<typeof reading>>
  let after!: Awaited<ReturnType<typeof reading>>
  const counted = await framed(page, browserSession, async () => {
    before = await reading()
    await sleep(scenario.windowMs)
    after = await reading()
  })
  return {
    layout: name,
    seconds: after.at - before.at,
    taskSeconds: after.task - before.task,
    ...counted,
    // Those in view at both ends of the window.
    inView: (await marksInView(page)).filter((mark) => seenBefore.includes(mark)),
    ...(await stopRecording(page, from)),
  }
}

/**
 * Clicks terminal `target`'s row and times it from the press to the first frame painted
 * after the target's screen is in the page and laid out: the frame callback that finds it
 * posts a message, which arrives once that frame has painted. A kept window is in the page
 * already, so its switch is the time to show it.
 */
export const switchTo = async (page: Page, target: number): Promise<Switch> => {
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
        .some((screen) => {
          const read = (screen.parentElement as { profileText?: () => string } | null)?.profileText
          return (read?.() ?? screen.textContent ?? "").includes(tag)
        })
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
export const select = async (page: Page, n: number) => {
  const where = await row(page, n)
  if (!where) throw new Error(`terminal ${n} has no row`)
  await page.mouse.click(where.x, where.y)
  await sleep(800)
}

/**
 * Shows terminal `n` in Focus: waits for the layout to settle, as a press during Focus's
 * first mount is lost, then selects it, and looks that its screen is the one in view, trying
 * again a few times; fails the scenario where it never is.
 */
export const focusOn = async (page: Page, n: number): Promise<void> => {
  await layout(page, "Focus")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each try follows the last.
    await sleep(500)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await select(page, n)
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (await until(async () => (await marksInView(page)).includes(n), 3000)) return
  }
  throw new Error(`Focus never showed terminal ${n}: ${JSON.stringify(await marksInView(page))}`)
}

/**
 * Waits until the app has booted, as it has once it offers a new terminal, having connected to
 * the runner. The stack has marked the welcome dialog seen (`markWelcomed`), so it is not up.
 */
export const boot = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "New terminal" }).first().waitFor({ timeout: 60_000 })
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
    const browserSession = await (browser as Browser).newBrowserCDPSession()
    await cdp.send("Performance.enable")
    await page.goto(stack.url, { waitUntil: "load" })
    await boot(page)
    await layout(page, "Focus")
    await setUp(page, scenario.terminals, (n) =>
      n <= scenario.agents ? stack.agent(n) : idleShell(n),
    )
    for (let seed = 1; seed <= scenario.agents; seed += 1) stack.busy(seed, true)
    const agents = Array.from({ length: scenario.agents }, (_, index) => index + 1)
    const phases = () => Promise.all(agents.map((n) => phase(page, n)))
    await until(async () => (await phases()).every((each) => each === "running"), 15_000)
    measured.agentPhases.push(...(await phases()))
    measured.steady.push(await steady(page, cdp, browserSession, "Grid"))
    // What a person watching an agent sees, the other four running beside it.
    await focusOn(page, 1)
    measured.steady.push(await steady(page, cdp, browserSession, "Focus"))
    for (let pass = 0; pass < scenario.switchPasses; pass += 1)
      for (const target of scenario.switchTargets)
        // eslint-disable-next-line no-await-in-loop -- One switch after another.
        measured.switches.push(await switchTo(page, target))
    for (let seed = 1; seed <= scenario.agents; seed += 1) stack.busy(seed, false)
  } finally {
    await browser.close()
  }
}
