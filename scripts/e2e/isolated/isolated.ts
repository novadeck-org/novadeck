// POSIX paths whatever runs the tests: a network namespace is Linux's alone.
import { basename, delimiter, dirname, join } from "node:path/posix"

/**
 * How the command gets a network namespace of its own:
 * - `sudo`: root makes it (`sudo unshare --net`), then hands the command back to the user
 *   with `setpriv`. This works where unprivileged user namespaces are restricted, as on
 *   Ubuntu 24.04 (`kernel.apparmor_restrict_unprivileged_userns`), and is what CI uses.
 * - `user`: an unprivileged user namespace owns it (`unshare --user --net`), and a nested
 *   one maps the user back to their own ids. No root needed.
 */
export type Mode = "sudo" | "user"

/** The programs the namespace is made with, by absolute path. */
export type Tools = {
  readonly unshare: string
  readonly ip: string
  readonly setpriv: string
  readonly sh: string
}

/** Who the command runs as: the user who asked for it. */
export type User = {
  readonly uid: number
  readonly gid: number
  readonly groups: readonly number[]
}

/** What the script was asked to do. */
export type Request =
  | { readonly kind: "run"; readonly command: readonly string[] }
  /** Inside the namespace, as the user: take the environment back, then run. */
  | { readonly kind: "restore"; readonly envFile: string; readonly command: readonly string[] }

export const usage = "usage: node scripts/e2e/isolated/main.ts [--] <command> [arguments...]"

/** The request in the script's arguments, or why there is none. */
export const parseRequest = (argv: readonly string[]): Request | Error => {
  if (argv[0] === "--restore") {
    const [, envFile, separator, ...command] = argv
    if (!envFile || separator !== "--" || command.length === 0)
      return new Error("--restore takes <file> -- <command>")
    return { kind: "restore", envFile, command }
  }
  const command = argv[0] === "--" ? argv.slice(1) : [...argv]
  if (command.length === 0) return new Error(usage)
  return { kind: "run", command }
}

/**
 * The mode `NOVADECK_E2E_NETNS` asks for, or without it `sudo` where sudo needs no
 * password, else `user`.
 */
export const chooseMode = (wanted: string | undefined, sudoWorks: () => boolean): Mode | Error => {
  if (wanted === "sudo" || wanted === "user") return wanted
  if (wanted) return new Error(`NOVADECK_E2E_NETNS is ${wanted}: use sudo or user`)
  return sudoWorks() ? "sudo" : "user"
}

// System folders come first, so root never runs a program from a folder the user can
// write, such as a Homebrew prefix on PATH.
const systemFolders = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

/** The program's absolute path, from the system's folders first, then PATH. */
export const findTool = (
  name: string,
  path: string | undefined,
  exists: (file: string) => boolean,
): string | undefined =>
  [...systemFolders, ...(path ?? "").split(delimiter).filter((folder) => folder.startsWith("/"))]
    .map((folder) => join(folder, name))
    .find(exists)

/**
 * Run by `sh` as root of the new namespace, with `ip` as `$1`: brings loopback up,
 * refuses to go on unless loopback is the only interface, then runs the rest. It counts
 * the interfaces with the shell's builtins, so root runs no program found on PATH.
 */
export const loopbackOnly = [
  '"$1" link set lo up || exit 125',
  'links=$("$1" -o link show | { n=0; while read -r _; do n=$((n + 1)); done; echo "$n"; })',
  'if [ "$links" -ne 1 ]; then',
  '  echo "isolated: the namespace has an interface besides loopback" >&2',
  "  exit 125",
  "fi",
  "shift",
  'exec "$@"',
].join("\n")

const inNamespace = (tools: Tools, rest: readonly string[]): string[] => [
  tools.sh,
  "-c",
  loopbackOnly,
  "isolated",
  tools.ip,
  ...rest,
]

/**
 * `sudo`'s arguments: a new network namespace, loopback up, then `setpriv` back to the
 * user, with their groups, to run `inner`. sudo resets the environment and PATH, so
 * `inner` takes it back from a file; nothing of it is on a command line.
 */
export const sudoArgs = (tools: Tools, user: User, inner: readonly string[]): string[] => [
  "-n",
  "--",
  tools.unshare,
  "--net",
  "--",
  ...inNamespace(tools, [
    tools.setpriv,
    `--reuid=${user.uid}`,
    `--regid=${user.gid}`,
    user.groups.length > 0 ? `--groups=${user.groups.join(",")}` : "--clear-groups",
    "--",
    ...inner,
  ]),
]

/**
 * `unshare`'s arguments without root: a user namespace where the user is root, owning a
 * new network namespace, loopback up, then a nested user namespace mapping the user back
 * to their own ids. The environment passes through as it is.
 */
export const userArgs = (tools: Tools, user: User, command: readonly string[]): string[] => [
  "--user",
  "--map-root-user",
  "--net",
  "--",
  ...inNamespace(tools, [
    tools.unshare,
    "--user",
    `--map-user=${user.uid}`,
    `--map-group=${user.gid}`,
    "--",
    ...command,
  ]),
]

/** The folder `os.tmpdir()` names in the environment, as Node finds it outside Windows. */
export const tempFolder = (env: NodeJS.ProcessEnv): string => {
  const folder = env.TMPDIR || env.TMP || env.TEMP || "/tmp"
  return folder.length > 1 && folder.endsWith("/") ? folder.slice(0, -1) : folder
}

/**
 * The folder holding the environment's file, which `--restore` deletes, by its real path:
 * only one the script made, a `novadeck-isolated-*` folder directly in `temp`, so a
 * mistaken `--restore` deletes nothing else.
 */
export const restoreFolder = (
  envFile: string,
  temp: string,
  realpath: (path: string) => string,
): string | Error => {
  const refused = new Error(
    `isolated: --restore takes a file in a novadeck-isolated-* folder in ${temp}, not ${envFile}`,
  )
  try {
    const folder = realpath(dirname(envFile))
    if (dirname(folder) !== realpath(temp)) return refused
    return basename(folder).startsWith("novadeck-isolated-") ? folder : refused
  } catch {
    return refused
  }
}

/** The exit code for a child that ended by a signal, as a shell reports it. */
export const signalCode = (signal: number): number => 128 + signal
