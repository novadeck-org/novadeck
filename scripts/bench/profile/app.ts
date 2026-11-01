import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { _electron, type ElectronApplication, type Page } from "playwright"

import { openedCopy } from "../../../apps/desktop/scripts/fuses.mjs"
import { openSandbox } from "../timing/sandbox.ts"

// The desktop app the profile runs: the unpacked package `pnpm --filter @novadeck/desktop
// package` builds, launched by Playwright's Electron driver inside the timing run's sandbox
// (see ../timing/sandbox.ts) with the GPU on. The app, the runner it starts and every shell
// get the sandbox's environment alone, plus what finds the X display (DISPLAY, XAUTHORITY):
// it draws through X11, under a Wayland session through XWayland, as the sandbox's runtime
// folder holds no Wayland socket.

const host = join(import.meta.dirname, "..", "..", "..", "apps", "desktop")

/**
 * Where the unpacked package is (`bundle`: its folder, or on macOS its app bundle), and
 * where in it its executable and its resources are.
 */
export const packaged = (): {
  readonly bundle: string
  readonly executable: string
  readonly resources: string
} => {
  const release = join(host, "release")
  if (process.platform === "darwin") {
    const folder = existsSync(release)
      ? readdirSync(release).find((name) => name.startsWith("mac"))
      : undefined
    const bundle =
      folder && readdirSync(join(release, folder)).find((name) => name.endsWith(".app"))
    if (!folder || !bundle) throw new Error(`no unpacked macOS app bundle in ${release}`)
    const root = join(release, folder, bundle, "Contents")
    return {
      bundle: join(release, folder, bundle),
      executable: join(root, "MacOS", "novadeck"),
      resources: join(root, "Resources"),
    }
  }
  const root = join(release, "linux-unpacked")
  return { bundle: root, executable: join(root, "novadeck"), resources: join(root, "resources") }
}

/** The machine the app runs on, as Chromium and Electron see it. */
export type Machine = {
  readonly gpu: unknown
  readonly gpuFeatures: Record<string, string>
  readonly displays: readonly {
    readonly size: { readonly width: number; readonly height: number }
    readonly scaleFactor: number
    readonly frequency: number
    readonly colorDepth: number
    readonly primary: boolean
  }[]
  readonly window: { readonly width: number; readonly height: number }
  readonly switches: readonly string[]
}

export type OpenedApp = {
  readonly app: ElectronApplication
  readonly page: Page
  readonly busy: (seed: number, on: boolean) => void
  readonly agent: (seed: number) => string
  /** The machine as the app saw it on launch, before its GPU process may have come up. */
  readonly machine: Machine
  /** The machine as the app sees it now: read once the run is done, its GPU status is the run's. */
  readonly readMachine: () => Promise<Machine>
  /** A folder inside the sandbox the app may write into, as its traces. */
  readonly scratch: string
}

export type AppRun = {
  /**
   * Launches the app in the sandbox, its window at `size`, shown and in front, with
   * `extra` Chromium switches besides its own.
   */
  readonly start: (
    size: { width: number; height: number },
    extra?: readonly string[],
  ) => Promise<OpenedApp>
  /**
   * Closes the app and removes the sandbox, once, however far `start` got. Returns what
   * went wrong inside the sandbox, as the timing run's `stop` does.
   */
  readonly stop: () => Promise<readonly string[]>
}

/** A fresh sandbox for one run of the app at `executable`, the package's by default; nothing runs yet. */
export const openApp = (executable = packaged().executable): AppRun => {
  const { sandbox, busy, agent, close } = openSandbox("novadeck-profile-")
  let app: ElectronApplication | undefined
  // The launch under way, which a stop waits out, so the app it starts is closed before the
  // sandbox is reaped and removed.
  let launching: Promise<unknown> | undefined
  let stopped: Promise<readonly string[]> | undefined
  // The package ships with Node's inspector shut, which Playwright's driver needs: the app
  // runs from a copy of its executable with only that fuse (and RunAsNode, NODE_OPTIONS) open.
  let opened: Awaited<ReturnType<typeof openedCopy>> | undefined
  const stop = () =>
    (stopped ??= (async () => {
      await launching?.catch(() => {})
      const running = app
      if (running) {
        const child = running.process()
        const closed = running.close().then(
          () => true,
          () => false,
        )
        const late = new Promise<false>((resolve) => setTimeout(resolve, 15_000, false).unref())
        // An app that won't close ends forcibly; the reaping catches what it leaves.
        if (!(await Promise.race([closed, late]))) child.kill("SIGKILL")
      }
      opened?.remove()
      return close()
    })())
  return {
    stop,
    start: async (size, extra = []) => {
      if (stopped) throw new Error("the run is stopping")
      if (!existsSync(executable)) throw new Error(`the packaged app is missing: ${executable}`)
      opened ??= await openedCopy(executable)
      const scratch = join(sandbox.root, "scratch")
      mkdirSync(scratch, { recursive: true })
      const display = Object.fromEntries(
        ["DISPLAY", "XAUTHORITY"].flatMap((name) => {
          const value = process.env[name]
          return value ? [[name, value]] : []
        }),
      )
      const switches = [
        `--user-data-dir=${join(sandbox.root, "user-data")}`,
        // The unpacked package's chrome-sandbox isn't setuid, and Ubuntu forbids the
        // unprivileged namespaces Chromium's sandbox needs otherwise, as the smoke test says.
        ...(process.platform === "linux" ? ["--no-sandbox", "--ozone-platform=x11"] : []),
        ...extra,
      ]
      // Playwright handles SIGINT, SIGTERM and SIGHUP itself, whatever it's told, and on
      // SIGINT ends the process once the app has closed, before `stop` has reaped and
      // checked the sandbox: its handlers go, and the caller's handle the signals.
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
      const before = signals.map((signal) => new Set(process.listeners(signal)))
      const launch = _electron.launch({
        executablePath: opened.executable,
        args: switches,
        cwd: sandbox.root,
        // A release's version would otherwise let the packaged app look for updates.
        env: { ...sandbox.env, ...display, NOVADECK_UPDATES: "off" },
        timeout: 60_000,
      })
      // The app is the run's as soon as it has launched, so a stop that waited out the launch
      // closes it before it reaps. A signal while the launch is under way still meets
      // Playwright's handlers, which haven't gone yet.
      const settled = launch
        .then((launched) => {
          app = launched
          return launched
        })
        .finally(() => {
          for (const [index, signal] of signals.entries())
            for (const listener of process.listeners(signal))
              if (!before[index]!.has(listener)) process.removeListener(signal, listener)
        })
      launching = settled
      const launched = await settled
      if (stopped) throw new Error("the run is stopping")
      const page = await launched.firstWindow({ timeout: 60_000 })
      await page.waitForLoadState("load")
      const window = await launched.evaluate(({ BrowserWindow }, wanted) => {
        const [shown] = BrowserWindow.getAllWindows()
        if (!shown) throw new Error("the app has no window")
        shown.setContentSize(wanted.width, wanted.height)
        shown.show()
        shown.moveTop()
        shown.focus()
        const [width = 0, height = 0] = shown.getContentSize()
        return { width, height }
      }, size)
      const read = () =>
        launched.evaluate(async ({ app: electron, screen }) => {
          const primary = screen.getPrimaryDisplay().id
          return {
            gpu: await electron.getGPUInfo("complete").catch((error: unknown) => String(error)),
            gpuFeatures: { ...electron.getGPUFeatureStatus() } as Record<string, string>,
            displays: screen.getAllDisplays().map((each) => ({
              size: each.size,
              scaleFactor: each.scaleFactor,
              frequency: each.displayFrequency,
              colorDepth: each.colorDepth,
              primary: each.id === primary,
            })),
          }
        })
      return {
        app: launched,
        page,
        busy,
        agent,
        scratch,
        machine: { ...(await read()), window, switches },
        readMachine: async () => ({ ...(await read()), window, switches }),
      }
    },
  }
}
