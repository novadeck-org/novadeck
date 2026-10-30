import { execFile } from "node:child_process"

import type { IpcMain } from "electron"

import { notificationsQuietChannel } from "../../bridge.js"

/** Runs a program and resolves with what it printed; rejects when it fails or runs too long. */
export type Run = (file: string, args: readonly string[], timeout: number) => Promise<string>

/** Runs programs in `env`, as the system's own programs expect to be started. */
export const runIn =
  (env: NodeJS.ProcessEnv): Run =>
  (file, args, timeout) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { env, timeout, windowsHide: true }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      )
    })

// How long an answer stays good, and how long a page waits for a fresh one before it gets
// the last one known. The page asks right before it plays its sound.
const fresh = 3000
const patience = 120

/**
 * Whether GNOME holds its banners back. Its Do Not Disturb switch is the `show-banners`
 * setting, read from the settings database without any notification server involved.
 */
export const gnomeQuiet = async (run: Run): Promise<boolean> => {
  const out = await run(
    "gsettings",
    ["get", "org.gnome.desktop.notifications", "show-banners"],
    1500,
  )
  return out.trim() === "false"
}

/**
 * Whether the notification server says it is inhibited: the `Inhibited` property of
 * `org.freedesktop.Notifications`, which KDE Plasma sets while Do Not Disturb holds, and
 * which other servers may. A server without the property fails the call, so it is not
 * quiet.
 */
export const inhibitedQuiet = async (run: Run): Promise<boolean> => {
  const out = await run(
    "gdbus",
    [
      "call",
      "--session",
      "--timeout",
      "1",
      "--dest",
      "org.freedesktop.Notifications",
      "--object-path",
      "/org/freedesktop/Notifications",
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      "org.freedesktop.Notifications",
      "Inhibited",
    ],
    1500,
  )
  return /<true>/.test(out)
}

/**
 * Whether XFCE's notification daemon is set to Do Not Disturb: `xfconf-query` prints `true`
 * for the `/do-not-disturb` property of `xfce4-notifyd`.
 */
export const xfceQuiet = async (run: Run): Promise<boolean> => {
  const out = await run("xfconf-query", ["-c", "xfce4-notifyd", "-p", "/do-not-disturb"], 1500)
  return out.trim() === "true"
}

/** Whether dunst is paused, which is its Do Not Disturb: `dunstctl is-paused` prints `true`. */
export const dunstQuiet = async (run: Run): Promise<boolean> => {
  const out = await run("dunstctl", ["is-paused"], 1500)
  return out.trim() === "true"
}

/**
 * The Linux probe for a desktop named as `XDG_CURRENT_DESKTOP` names it: the desktop's own
 * setting where it has one, then the notification servers that can be asked whatever the
 * desktop is. The ones that apply are asked together; a missing program or a failed call
 * reads as not quiet, and any one that says so makes it quiet.
 */
export const linuxProbe = (run: Run, desktop: string | undefined) => async (): Promise<boolean> => {
  const names = (desktop ?? "").toLowerCase().split(":")
  const asks = names.some((name) => ["gnome", "unity", "ubuntu"].includes(name))
    ? [gnomeQuiet]
    : names.includes("xfce")
      ? [xfceQuiet, dunstQuiet]
      : [inhibitedQuiet, dunstQuiet]
  const answers = await Promise.all(asks.map((ask) => ask(run).catch(() => false)))
  return answers.some(Boolean)
}

// What the Windows probe asks of the system. Focus Assist is not reported by
// `SHQueryUserNotificationState`, whose quiet time is only a new account's first hour, so the
// shell's own state is read: the WNF state `WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED`
// (0x0D83063EA3BF1C75), whose data is 0 when notifications are all allowed, and above 0 while
// Priority only or Alarms only holds. WNF is undocumented, and that Windows 11's Do Not
// Disturb publishes the same state is unverified: it is the state community reverse
// engineering of Focus Assist names, and any failure reads as not quiet.
const quietHoursState = 0x0d83063ea3bf1c75n

/** Reads the shell's quiet hours state: its value, or undefined when the system gives none. */
export type StateQuery = () => Promise<number | undefined>

/**
 * `NtQueryWnfStateData` from the system library, called in this process through koffi. The
 * binding is made on the first query and only on Windows, so no other platform loads it.
 */
export const ntdllQuery = (): StateQuery => {
  let call: (() => number | undefined) | undefined
  return async () => {
    if (!call) {
      const { default: koffi } = await import("koffi")
      const query = koffi
        .load("ntdll.dll")
        .func(
          "int __stdcall NtQueryWnfStateData(uint64_t *name, void *type, void *scope, _Out_ uint32_t *stamp, _Out_ uint32_t *buffer, _Inout_ uint32_t *size)",
        ) as (...args: unknown[]) => number
      const name = new BigUint64Array([quietHoursState])
      call = () => {
        const stamp = new Uint32Array(1)
        // Room for more than the 4 bytes the state holds, so a build that publishes more
        // still answers rather than fail as too small.
        const buffer = new Uint32Array(4)
        const size = new Uint32Array([buffer.byteLength])
        return query(name, null, null, stamp, buffer, size) === 0 ? buffer[0] : undefined
      }
    }
    return call()
  }
}

/**
 * The Windows probe: quiet while the shell's quiet hours state is above 0. The first query
 * that fails, as one would if the build lost koffi's binary, goes to `warn`, once.
 */
export const windowsProbe = (
  query: StateQuery = ntdllQuery(),
  warn: (error: unknown) => void = () => undefined,
): (() => Promise<boolean>) => {
  let warned = false
  return async () => {
    const value = await query().catch((error: unknown) => {
      if (!warned) warn(error)
      warned = true
      return undefined
    })
    return (value ?? 0) > 0
  }
}

/**
 * Whether the system holds notifications back right now, as Do Not Disturb, Focus or
 * Focus Assist does. Answers from a short-lived cache, and when a probe is slower than a
 * page will wait, with the last answer it knows; never rejects, and answers false where it
 * cannot tell. `probe` is the platform's way of asking; none means the platform has none.
 */
export const notificationsQuiet = (
  probe: (() => Promise<boolean>) | undefined,
  // A clock that never steps back, as the wall clock may when it is set.
  now: () => number = () => performance.now(),
  wait: number = patience,
): (() => Promise<boolean>) => {
  let known = false
  let asked = Number.NEGATIVE_INFINITY
  let pending: Promise<boolean> | undefined
  const refresh = (): Promise<boolean> => {
    pending ??= (async () => {
      try {
        known = (await probe!()) === true
      } catch {
        known = false
      }
      asked = now()
      pending = undefined
      return known
    })()
    return pending
  }
  return async () => {
    if (!probe) return false
    if (now() - asked < fresh) return known
    const answer = refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(known), wait)
    })
    try {
      return await Promise.race([answer, late])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The quiet probe of this platform. macOS has none: Focus is stored in files the app may not
 * read without Full Disk Access, so it reads as not quiet. `warm` asks once ahead of the
 * page, so its first question is answered from a real answer and not the default.
 */
export const platformQuiet = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  run: Run = runIn(env),
  windows: () => Promise<boolean> = windowsProbe(),
): { readonly quiet: () => Promise<boolean>; readonly warm: () => void } => {
  const probe =
    platform === "win32"
      ? windows
      : platform === "linux"
        ? linuxProbe(run, env["XDG_CURRENT_DESKTOP"])
        : undefined
  const quiet = notificationsQuiet(probe)
  return { quiet, warm: () => void (probe && quiet()) }
}

/**
 * Answers the page's question whether the system holds notifications back. `window` names
 * the window of a request from the app's own page; any other sender is told it does not.
 */
export const registerQuietIpc = <Window>(
  ipc: Pick<IpcMain, "handle">,
  {
    window,
    quiet,
  }: {
    readonly window: (event: Parameters<Parameters<IpcMain["handle"]>[1]>[0]) => Window | undefined
    readonly quiet: () => Promise<boolean>
  },
): void => {
  ipc.handle(notificationsQuietChannel, async (event) => {
    if (window(event) === undefined) return false
    try {
      return (await quiet()) === true
    } catch {
      return false
    }
  })
}
