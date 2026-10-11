import { execFile } from "node:child_process"
import { join } from "node:path"

/** The name `env` keeps PATH under: Windows' own spelling is "Path". */
export const pathKey = (env: NodeJS.ProcessEnv): string =>
  Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"

// "C:\Tools\", "c:\tools" and `"C:\Tools"` are one folder to Windows; a drive's root keeps
// its backslash, as "C:" alone is the drive's current folder, another one.
const folderKey = (folder: string): string => {
  const bare = folder.trim().replace(/^"(.*)"$/, "$1")
  return (
    /^[a-z]:[\\/]+$/i.test(bare) ? `${bare.slice(0, 2)}\\` : bare.replace(/[\\/]+$/, "")
  ).toLowerCase()
}

/**
 * `current` as it is, then the registry's folders it lacks, in the registry's order, each
 * folder once: what the app was started with keeps its order, and only gains.
 */
export const mergePath = (current: string, registry: readonly string[]): string => {
  const seen = new Set<string>()
  return [...current.split(";"), ...registry]
    .filter((folder) => {
      const key = folderKey(folder)
      if (key === "" || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(";")
}

type Variables = { readonly [name: string]: unknown }

// A key's PATH value, whatever case its name is in.
const pathOf = (variables: Variables): unknown =>
  Object.entries(variables).find(([name]) => name.toUpperCase() === "PATH")?.[1]

/**
 * `value` with each `%NAME%` replaced as Windows does for a new process: by the registry's
 * variable of that name, any case, else the environment's, else left as written.
 */
const expand = (value: string, variables: Variables, env: NodeJS.ProcessEnv): string => {
  const named = new Map<string, string>()
  for (const [name, each] of Object.entries(env))
    if (each !== undefined) named.set(name.toUpperCase(), each)
  for (const [name, each] of Object.entries(variables))
    if (typeof each === "string") named.set(name.toUpperCase(), each)
  let text = value
  // A variable may itself name another, as nvm-windows' NVM_SYMLINK can.
  for (let pass = 0; pass < 4 && /%[^%;]+%/.test(text); pass += 1)
    text = text.replaceAll(
      /%([^%;]+)%/g,
      (whole, name: string) => named.get(name.toUpperCase()) ?? whole,
    )
  return text
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/
const decoded = (text: string): string => Buffer.from(text, "base64").toString("utf8")

/**
 * The machine's and then the user's PATH folders, from the lookup's answer: a line for
 * each of a key's text values as the registry holds it, unexpanded, as `machine` or
 * `user`, its name and its value, each in base64. Each PATH is expanded against the
 * registry's own variables, the user's over the machine's for the user's PATH, as Windows
 * builds a new process's environment, before `env`'s stale ones: an install that added a
 * variable and a PATH entry naming it (nvm-windows' `%NVM_SYMLINK%`, a JDK's
 * `%JAVA_HOME%\bin`) is found. Undefined for an answer that isn't one.
 */
export const registryFolders = (
  answer: string,
  env: NodeJS.ProcessEnv = {},
): readonly string[] | undefined => {
  const machines: Record<string, string> = {}
  const users: Record<string, string> = {}
  const lines = answer.split(/\r?\n/).filter((line) => line !== "")
  if (lines.length === 0) return undefined
  for (const line of lines) {
    // An empty name or value is empty in base64 too, as a key's default value or a
    // variable set to nothing: the line keeps its spaces.
    const [scope, name, value, ...more] = line.split(" ")
    if (scope !== "machine" && scope !== "user") return undefined
    if (name === undefined || value === undefined || more.length > 0) return undefined
    if (!base64.test(name) || !base64.test(value)) return undefined
    ;(scope === "machine" ? machines : users)[decoded(name)] = decoded(value)
  }
  const machinePath = pathOf(machines)
  const userPath = pathOf(users)
  return [
    ...(typeof machinePath === "string" ? expand(machinePath, machines, env).split(";") : []),
    ...(typeof userPath === "string"
      ? expand(userPath, { ...machines, ...users }, env).split(";")
      : []),
  ]
}

// Each key's text values unexpanded, a line each (see `registryFolders`); base64 keeps
// any folder's name, which a console code page would not, as reg.exe's output loses "Ł".
// .NET alone, no cmdlet: one, as ConvertTo-Json, has PowerShell look through every
// module on PSModulePath first, which took past five seconds on a CI runner with many.
const lookup = [
  "$b64 = { param($text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }",
  "$read = { param($scope, $key) if ($key) { foreach ($name in $key.GetValueNames()) { $value = $key.GetValue($name, '', 'DoNotExpandEnvironmentNames'); if ($value -is [string]) { $scope + ' ' + (& $b64 $name) + ' ' + (& $b64 $value) } } } }",
  "& $read 'machine' ([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'))",
  "& $read 'user' ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'))",
].join("; ")

/**
 * PATH's folders as the registry has them now; "timeout" where the read ran past
 * `timeoutMs`, as on a cold start with an antivirus scanning PowerShell; or undefined
 * where it failed outright, as where PowerShell may not run or the answer isn't one.
 */
const readRegistry = (env: NodeJS.ProcessEnv, timeoutMs: number) =>
  new Promise<readonly string[] | "timeout" | undefined>((resolve) => {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows"
    const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lookup],
      { env, timeout: timeoutMs, windowsHide: true },
      (error, stdout) =>
        resolve(
          error
            ? (error as { killed?: boolean }).killed
              ? "timeout"
              : undefined
            : registryFolders(stdout, env),
        ),
    )
  })

// The registry's folders last read, for every caller; until when no read is tried after
// one that failed; and the read under way, if any: one PowerShell at a time, not one per
// terminal, as a workspace restored with many.
let last: { readonly at: number; readonly folders: readonly string[] } | undefined
let failedUntil: number | undefined
// Reads in a row that ran long, each waited out twice as long as the one before.
let timeouts = 0
let reading: Promise<readonly string[] | undefined> | undefined

type Timing = {
  readonly timeoutMs: number
  readonly maxAgeMs: number
  readonly retryMs: number
  readonly timeoutRetryMs: number
}

const folders = (
  env: NodeJS.ProcessEnv,
  { timeoutMs, maxAgeMs, retryMs, timeoutRetryMs }: Timing,
  read: typeof readRegistry,
): Promise<readonly string[] | undefined> => {
  const now = Date.now()
  if (last && now - last.at <= maxAgeMs) return Promise.resolve(last.folders)
  // Where the registry can't be read, as where PowerShell may not run, no caller waits on
  // it again for a while: each gets the last answer, however old, or none.
  if (failedUntil !== undefined && now <= failedUntil) return Promise.resolve(last?.folders)
  reading ??= read(env, timeoutMs).then((found) => {
    if (Array.isArray(found)) last = { at: now, folders: found }
    // A read that only ran long, as the first after a cold boot, is tried again soon; where
    // PowerShell is always that slow, each time later, up to `retryMs`.
    timeouts = found === "timeout" ? timeouts + 1 : 0
    failedUntil = Array.isArray(found)
      ? undefined
      : Date.now() +
        (found === "timeout" ? Math.min(timeoutRetryMs * 2 ** (timeouts - 1), retryMs) : retryMs)
    reading = undefined
    return Array.isArray(found) ? found : last?.folders
  })
  return reading
}

/**
 * `env` with PATH as a new Windows terminal would have it. A Windows program keeps the
 * environment it started with, and passes it on: an app opened from a browser that has
 * run since before an install never sees that install's folder on PATH. The registry
 * has it, as Explorer and new consoles do. An answer up to `maxAgeMs` old serves at once;
 * past that, the registry is read again, at most `timeoutMs`, and every caller meanwhile
 * waits on that one read: a terminal opened after an install finds what it installed.
 * After a read that failed, none is tried again for `retryMs`, or `timeoutRetryMs` after
 * one that only ran past `timeoutMs`, doubled for each such read in a row up to `retryMs`.
 * Elsewhere, and when the registry can't be read, `env` stays as it is, or gains what
 * was read last.
 */
export const refreshPath = async (
  env: NodeJS.ProcessEnv,
  {
    platform = process.platform,
    timeoutMs = 5_000,
    maxAgeMs = 30_000,
    retryMs = 300_000,
    timeoutRetryMs = 15_000,
    read = readRegistry,
  }: {
    readonly platform?: NodeJS.Platform
    readonly timeoutMs?: number
    readonly maxAgeMs?: number
    readonly retryMs?: number
    readonly timeoutRetryMs?: number
    readonly read?: typeof readRegistry
  } = {},
): Promise<NodeJS.ProcessEnv> => {
  if (platform !== "win32") return env
  const found = await folders(env, { timeoutMs, maxAgeMs, retryMs, timeoutRetryMs }, read)
  if (!found) return env
  const key = pathKey(env)
  return { ...env, [key]: mergePath(env[key] ?? "", found) }
}

/** Forgets what was read, as a test that reads afresh needs. */
export const forgetPath = (): void => {
  last = undefined
  failedUntil = undefined
  timeouts = 0
  reading = undefined
}
