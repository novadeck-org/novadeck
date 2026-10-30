// Starting another copy of the app in place of this one.

const appImageVariables = new Set(["APPIMAGE", "APPDIR", "OWD", "ARGV0"])

// The variables AppRun prefixes with paths under the AppImage's mount.
const pathVariables = new Set(["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"])

// Whether `entry` is `folder` or lies under it.
const isUnder = (entry: string, folder: string): boolean => {
  const trimmed = entry.replace(/\/+$/u, "")
  return trimmed === folder || trimmed.startsWith(`${folder}/`)
}

/**
 * The environment the installed copy starts with: this one's, less the variables the
 * AppImage runtime set for this copy, which would make the installed one believe it runs
 * from this file and mount point, and less every entry of the path lists AppRun extended
 * that is in `mounts`, the folders this copy is mounted at. The mount goes away with this
 * copy, and something put at the same path afterwards would be searched first. A list
 * left empty is dropped.
 */
export const installedEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  mounts: readonly string[],
): Record<string, string | undefined> => {
  // A mount of "/" would take every entry, and an empty one names nothing.
  const folders = mounts.map((mount) => mount.replace(/\/+$/u, "")).filter((mount) => mount !== "")
  const kept = Object.entries(env).filter(([name]) => !appImageVariables.has(name))
  return Object.fromEntries(
    kept.flatMap(([name, value]): [string, string | undefined][] => {
      if (value === undefined || !pathVariables.has(name)) return [[name, value]]
      const entries = value
        .split(":")
        .filter((entry) => !folders.some((folder) => isUnder(entry, folder)))
      return entries.length === 0 ? [] : [[name, entries.join(":")]]
    }),
  )
}

/** The part of a child process that starting the installed copy uses. */
export type StartedProcess = {
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  unref(): void
}

// What the shell runs to start the installed copy: it closes every file descriptor above
// the standard three, which Chromium leaves open to the child, and then becomes the app.
// The descriptors hold files in the mount of this copy's AppImage, which would then stay
// mounted as long as the installed app runs. Bash is needed: dash cannot name those above 9.
export const closeDescriptors =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$0"'
// What the shell runs first to wait for the process in $1 to be gone, for at most 30 seconds.
const waitForExit =
  'n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done'
// Where bash may be; the first that can run starts the copy.
const shells = ["/bin/bash", "/usr/bin/bash"]

/**
 * Starts the AppImage `image` in place of this process and ends it, as electron-updater
 * restarts an AppImage: a detached child with no arguments of this one's, which may carry
 * `--no-sandbox` for a system this copy ran on. Electron's own `relaunch` would not do on
 * Linux: its child inherits no-new-privileges, and the AppImage runtime then cannot mount
 * itself. The child starts through bash, which closes the descriptors it inherited and
 * becomes the app, or directly, logged, when there is no bash at /bin or /usr/bin. The
 * lock on the data folder is let go first so the child can take it, and taken back with
 * `reclaimLock` should the start fail (this process ends if that is refused). Resolves true
 * after `exit`, or false, having logged why, when the child could not be started, as with
 * a missing file or exec bit: `runnable` says whether a path can be executed, as bash
 * would only report that after the fact.
 */
export const startAppImage = ({
  image,
  after,
  env,
  mounts,
  spawn,
  runnable,
  releaseLock,
  reclaimLock,
  exit,
  log,
}: {
  readonly image: string
  /**
   * A process to wait for before the child starts the app, for a start that happens while
   * this process is still shutting down: the child polls until the process is gone (at most
   * 30 seconds), so the app never starts beside its windows and storage. Needs bash; without
   * it nothing is started, as starting at once is the very thing waiting avoids.
   */
  readonly after?: number | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  /** The folders this copy's AppImage is mounted at, which the child's environment drops. */
  readonly mounts: readonly string[]
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly detached: true
      readonly stdio: "ignore"
      readonly env: Record<string, string | undefined>
    },
  ) => StartedProcess
  readonly runnable: (path: string) => boolean
  readonly releaseLock: () => void
  /** Takes the lock back after a failed start; false when another process holds it. */
  readonly reclaimLock: () => boolean
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    if (!runnable(image)) {
      log("The installed copy has no executable to start.", image)
      return resolve(false)
    }
    releaseLock()
    const failed = (error: unknown): void => {
      log("The installed copy did not start.", error)
      if (!reclaimLock()) exit()
      resolve(false)
    }
    try {
      const bash = shells.find(runnable)
      if (bash === undefined)
        log(
          "Starting the installed copy without bash, so this copy's mount stays while it runs.",
          image,
        )
      if (bash === undefined && after !== undefined) {
        log("The installed copy was not started: waiting for this one to exit needs bash.", image)
        return failed(new Error("no bash to wait with"))
      }
      const [file, args] =
        bash === undefined
          ? [image, [] as string[]]
          : after === undefined
            ? [bash, ["-c", closeDescriptors, image]]
            : [bash, ["-c", `${waitForExit}; ${closeDescriptors}`, image, String(after)]]
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        env: installedEnvironment(env, mounts),
      })
      child.once("error", failed)
      child.once("spawn", () => {
        child.unref()
        exit()
        resolve(true)
      })
    } catch (error) {
      failed(error)
    }
  })

/**
 * Starts the program `file` with `args` as a detached child and ends this process, the way
 * an installed copy or the uninstaller is started. The single-instance lock is let go
 * first so the program started can take it. Should the start fail after that, the lock is
 * taken back with `reclaimLock`; if it is refused, another copy has it and this process
 * ends. Never through the shell, which would run it past SmartScreen and Mark of the Web.
 * Resolves true after `exit`, or false, having logged why, when the file is missing or the
 * system refused to start it, as an application control policy (Smart App Control) does.
 */
export const startDetached = ({
  file,
  args = [],
  cwd,
  spawn,
  exists,
  releaseLock,
  reclaimLock,
  exit,
  log,
}: {
  readonly file: string
  readonly args?: readonly string[]
  readonly cwd?: string | undefined
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly detached: true
      readonly stdio: "ignore"
      readonly cwd?: string
    },
  ) => StartedProcess
  readonly exists: (path: string) => boolean
  readonly releaseLock: () => void
  /** Takes the lock back after a failed start; false when another process holds it. */
  readonly reclaimLock: () => boolean
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    if (!exists(file)) {
      log("There is no program to start.", file)
      return resolve(false)
    }
    releaseLock()
    const failed = (error: unknown): void => {
      log("The program did not start.", error)
      if (!reclaimLock()) exit()
      resolve(false)
    }
    try {
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        ...(cwd === undefined ? {} : { cwd }),
      })
      child.once("error", failed)
      child.once("spawn", () => {
        child.unref()
        exit()
        resolve(true)
      })
    } catch (error) {
      failed(error)
    }
  })
