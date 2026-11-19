import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { cpus, loadavg } from "node:os"
import { extname, join, normalize, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { chromium, type CDPSession, type Page } from "playwright"

import { configProblem, defaults, type Config } from "./scenario.ts"
import { markdown, summarize, type Bench, type Report, type Sample, type Timed } from "./summary.ts"

// `pnpm bench:files [--label <name>] [--folders n] [--files n] [--worktrees n] [--changed n]
// [--files-per-worktree n] [--polls n] [--warmup n] [--turns n] [--synced] [--seed n]`: times
// the Files sidebar panel as works change. See README.md.

const root = join(import.meta.dirname, "..", "..", "..")
const app = join(root, "apps/try")
const ui = join(root, "frontend/ui")
const pageDir = join(import.meta.dirname, "page")

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "main" },
    folders: { type: "string" },
    files: { type: "string" },
    worktrees: { type: "string" },
    changed: { type: "string" },
    "files-per-worktree": { type: "string" },
    polls: { type: "string" },
    warmup: { type: "string" },
    turns: { type: "string" },
    seed: { type: "string" },
    synced: { type: "boolean", default: false },
  },
})

const number = (text: string | undefined, fallback: number): number =>
  text === undefined ? fallback : Number(text)

const config: Config = {
  folders: number(values.folders, defaults.folders),
  files: number(values.files, defaults.files),
  worktrees: number(values.worktrees, defaults.worktrees),
  changed: number(values.changed, defaults.changed),
  filesPerWorktree: number(values["files-per-worktree"], defaults.filesPerWorktree),
  polls: number(values.polls, defaults.polls),
  warmup: number(values.warmup, defaults.warmup),
  turns: number(values.turns, defaults.turns),
  synced: values.synced,
  seed: number(values.seed, defaults.seed),
}
const problem = configProblem(config)
if (problem) throw new Error(problem)
const label = values.label
if (!/^[\w.-]+$/.test(label)) throw new Error("--label takes letters, digits, . _ and -")

const out = join(root, ".cache", "bench", "files", label)
const site = join(out, "page")
rmSync(out, { recursive: true, force: true })
mkdirSync(site, { recursive: true })

// The app's own Vite and plugins, as the root has none: only the build is used.
const fromApp = createRequire(join(app, "package.json"))
const load = async <T>(name: string): Promise<T> =>
  (await import(pathToFileURL(fromApp.resolve(name)).href)) as T
const vite = await load<{ build: (config: Record<string, unknown>) => Promise<unknown> }>("vite")
const tailwind = await load<{ default: () => unknown }>("@tailwindcss/vite")
const react = await load<{ default: () => unknown }>("@vitejs/plugin-react")
const fromUi = createRequire(join(ui, "package.json"))
const packageDir = (name: string): string => resolve(fromUi.resolve(`${name}/package.json`), "..")

console.log("Building the page...")
await vite.build({
  configFile: false,
  root: pageDir,
  base: "./",
  logLevel: "error",
  // The page's own copies of React would be a second React beside the panel's.
  // Workspace packages resolve to their source, so no package needs building first.
  resolve: {
    conditions: ["development", "module", "browser"],
    alias: [
      // React's profiling build, which is the production one with the Profiler on: its commits
      // are counted. (The Profiler does nothing in the plain production build.)
      { find: /^react-dom\/client$/, replacement: `${packageDir("react-dom")}/profiling` },
      { find: /^react-dom(\/.*)?$/, replacement: `${packageDir("react-dom")}$1` },
      { find: /^react(\/.*)?$/, replacement: `${packageDir("react")}$1` },
    ],
  },
  build: { outDir: site, emptyOutDir: true, assetsInlineLimit: 0, minify: true },
  plugins: [tailwind.default(), react.default()],
})

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const serve = (): Promise<{ server: Server; url: string }> =>
  new Promise((done) => {
    const server = createServer((request, response) => {
      const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname))
      const file = join(site, path.endsWith("/") ? `${path}index.html` : path)
      try {
        if (!file.startsWith(site)) throw new Error("outside")
        response.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
        })
        response.end(readFileSync(file))
      } catch {
        response.writeHead(404).end()
      }
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      done({ server, url: `http://127.0.0.1:${typeof address === "object" ? address?.port : 0}/` })
    })
  })

/** Chromium's cumulative main-thread counters, in ms. */
type Counters = { task: number; script: number; layout: number; style: number }
const counters = async (session: CDPSession): Promise<Counters> => {
  const { metrics } = await session.send("Performance.getMetrics")
  const ms = (name: string): number =>
    (metrics.find((each) => each.name === name)?.value ?? 0) * 1000
  return {
    task: ms("TaskDuration"),
    script: ms("ScriptDuration"),
    layout: ms("LayoutDuration"),
    style: ms("RecalcStyleDuration"),
  }
}

const timed = async (
  page: Page,
  session: CDPSession,
  run: () => Promise<Timed>,
): Promise<Sample> => {
  const before = await counters(session)
  const result = await run()
  const after = await counters(session)
  return {
    ...result,
    busyMs: after.task - before.task,
    scriptMs: after.script - before.script,
    layoutMs: after.layout - before.layout,
    styleMs: after.style - before.style,
  }
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
})()

const { server, url } = await serve()
// A real probe reads the page as a person's browser would: no CI or NO_COLOR from the shell.
const env = { ...process.env }
delete env["CI"]
delete env["NO_COLOR"]
const browser = await chromium.launch({ headless: true, env })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 960 } })
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`))
  const session = await page.context().newCDPSession(page)
  await session.send("Performance.enable")
  await page.goto(`${url}#${encodeURIComponent(JSON.stringify(config))}`)
  await page.evaluate(() => (window as unknown as { bench: Bench }).bench.ready)
  console.log(
    `Panel ready: ${await page.locator('[role="tree"] [data-path]').count()} rows mounted.`,
  )

  // What the panel's own background work (the trails' animations) costs with nothing happening.
  await sleep(2000)
  const idleFrom = await counters(session)
  await sleep(1000)
  const idleBusyMs = (await counters(session)).task - idleFrom.task
  const loadBefore = loadavg()[0] ?? 0

  const polls: Sample[] = []
  for (let poll = 0; poll < config.warmup + config.polls; poll++) {
    // oxlint-disable-next-line no-await-in-loop -- Polls are fed one at a time, as the runner's are.
    const sample = await timed(page, session, () =>
      page.evaluate((each) => (window as unknown as { bench: Bench }).bench.poll(each), poll),
    )
    if (poll >= config.warmup) polls.push(sample)
  }
  const turns: Sample[] = []
  for (let turn = 0; turn < config.turns; turn++) {
    // oxlint-disable-next-line no-await-in-loop -- As above.
    const sample = await timed(page, session, () =>
      page.evaluate(() => (window as unknown as { bench: Bench }).bench.turn()),
    )
    turns.push(sample)
  }
  await page.screenshot({ path: join(out, "panel.png") })

  const report: Report = {
    version: 1,
    label,
    startedAt: new Date().toISOString(),
    commit,
    environment: {
      platform: process.platform,
      node: process.version,
      cpus: cpus().length,
      cpu: cpus()[0]?.model ?? "unknown",
      chromium: browser.version(),
      // Other work on the machine moves the numbers: the 1-minute load average at the start of
      // the polls and at their end, and the page's busy time over an idle second.
      loadBefore: Number(loadBefore.toFixed(1)),
      loadAfter: Number((loadavg()[0] ?? 0).toFixed(1)),
      idleBusyMs: Number(idleBusyMs.toFixed(1)),
    },
    config,
    polls,
    turns,
    summary: { polls: summarize(polls), turns: turns.length > 0 ? summarize(turns) : null },
  }
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(out, "summary.md"), markdown(report))
  console.log(markdown(report))
  console.log(`Wrote ${out}`)
} finally {
  await browser.close()
  server.close()
}
