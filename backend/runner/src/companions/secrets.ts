import { existsSync, realpathSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path"

import { harnesses } from "@novadeck/protocol"

// Files that often hold secrets: a key, credentials, an environment file, an agent's or a
// tool's login, a shell's history. Novadeck shows them, as any file the person can
// read, but never puts one on screen by itself, as while the person shares it.
const secretFolders = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"])
const secretNames = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.envrc$/i,
  /^\.?credentials(\.[\w.]+)?$/i,
  /^oauth_creds\.json$/i,
  /^\.yarnrc\.yml$/i,
  /^\.s3cfg$/i,
  /^rclone\.conf$/i,
  /^fish_history$/i,
  /^\.vault-token$/i,
  /^\.dockercfg$/i,
  /^kubeconfig$/i,
  /^\.[\w-]*_history$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|txt|properties)$/i,
  /^service-account.*\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_[^.]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|tfstate)$/i,
]
// gcloud's folder, whose name is too plain to hold everywhere.
const secretPaths = [/[\\/](\.config|AppData[\\/]Roaming)[\\/]gcloud[\\/]/i]

// Logins under names too plain to hold everywhere, each one of `files` in its tool's home:
// a folder named as one of `folders`, the one `variable` names, or any that holds one of
// `beside` (see the harness table's `logins`). The GitHub CLI's hosts.yml, in "GitHub CLI"
// on Windows, and the harnesses' own. Names are lower case, as they are compared.
type Login = {
  readonly files: readonly string[]
  readonly folders: readonly string[]
  readonly variable: string
  readonly beside: readonly string[]
}
const harnessLogins: readonly (typeof harnesses)[number]["logins"][number][] = harnesses.flatMap(
  (harness) => [...harness.logins],
)
const logins: readonly Login[] = [
  {
    files: ["hosts.yml", "hosts.yaml"],
    folders: ["gh", "github cli"],
    variable: "GH_CONFIG_DIR",
    beside: [],
  },
  ...harnessLogins.map(({ file, folder, variable, beside }) => ({
    files: [file.toLowerCase()],
    folders: [folder.toLowerCase()],
    variable,
    beside,
  })),
]
// The variables that move one of the folders above, gcloud's included, and those that name
// one file a tool keeps its login in, wherever it is; kubectl's names a list of them.
const folderVariables = ["GNUPGHOME", "AZURE_CONFIG_DIR", "DOCKER_CONFIG", "CLOUDSDK_CONFIG"]
const fileVariables = [
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "KUBECONFIG",
  "NPM_CONFIG_USERCONFIG",
  "NETRC",
  "PGPASSFILE",
  "RCLONE_CONFIG",
  "HISTFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
]
const listVariables = new Set(["KUBECONFIG"])

/**
 * The variables that say where a tool keeps its logins, which `secret` reads from the
 * environment it is given: whoever gathers the person's environment keeps these.
 */
export const secretVariables: readonly string[] = [
  ...new Set([...logins.map(({ variable }) => variable), ...folderVariables, ...fileVariables]),
]

// A path as the list compares it: whole, and in one case, as every name above is.
const fold = (path: string): string => resolve(path).toLowerCase()

// The places a variable's value names, each as written and as it resolves through links,
// since a file is asked about by either. None for a value that names no one place: a
// relative path, which only the tool's own folder completes, or a filesystem's root.
const placesOf = (value: string | undefined, list: boolean): readonly string[] =>
  (value ? (list ? value.split(delimiter) : [value]) : [])
    .filter((place) => isAbsolute(place) && dirname(resolve(place)) !== resolve(place))
    .flatMap((place) => {
      try {
        return [fold(place), fold(realpathSync.native(place))]
      } catch {
        // Not there, or not to be read: as written is all there is.
        return [fold(place)]
      }
    })

/**
 * Tells whether a file, by its resolved path, may hold secrets: it opens only when the
 * person picks it. `env` is the person's environment, as far as it is known, read once
 * here for the tools whose logins a variable moves, so many files are judged by one
 * reading. Only a file named as a harness's login has its folder looked at.
 */
export const secrets = (env: NodeJS.ProcessEnv = process.env): ((path: string) => boolean) => {
  // A name in any case, as Windows reads one, which a copy of an environment forgets.
  const upper = new Map(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]))
  const places = (variable: string) =>
    placesOf(env[variable] ?? upper.get(variable), listVariables.has(variable))
  const homes = logins.map((login) => ({ ...login, moved: places(login.variable) }))
  const folders = folderVariables.flatMap(places)
  const files = new Set(fileVariables.flatMap(places))
  return (path) => {
    // Either separator, in any case: an agent on Windows may name a path with both.
    const parts = path
      .toLowerCase()
      .split(/[\\/]/)
      .filter((part) => part !== "")
    const name = parts.at(-1) ?? ""
    if (parts.some((part) => secretFolders.has(part))) return true
    if (secretNames.some((pattern) => pattern.test(name))) return true
    if (secretPaths.some((pattern) => pattern.test(path))) return true
    const folder = dirname(path)
    const home = homes.some(
      (login) =>
        login.files.includes(name) &&
        (login.folders.includes(parts.at(-2) ?? "") ||
          login.moved.includes(fold(folder)) ||
          login.beside.some((mark) => existsSync(join(folder, mark)))),
    )
    if (home) return true
    const whole = fold(path)
    return files.has(whole) || folders.some((place) => whole.startsWith(place + sep))
  }
}

/** Whether one file may hold secrets (see `secrets`). */
export const secret = (path: string, env?: NodeJS.ProcessEnv): boolean => secrets(env)(path)
