import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, parse, sep } from "node:path"

import { it as base, describe, expect } from "../test.js"
import { secret, secrets, secretVariables } from "./secrets.js"

const at = (...parts: string[]) => join(sep, "home", "u", ...parts)

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    // Native, as paths are resolved: on Windows it also expands short names.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-secrets-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

// A folder with the files named in it, each empty: only where a file is tells.
const folder = (directory: string, name: string, files: readonly string[] = []) => {
  const made = join(directory, name)
  mkdirSync(made, { recursive: true })
  for (const file of files) writeFileSync(join(made, file), "")
  return made
}

describe("a file that may hold secrets", () => {
  it("is a key, credentials, an environment file, or anything in a folder of keys", () => {
    for (const path of [".env", ".env.local", join(".ssh", "config"), "server.pem", "id_ed25519"])
      expect(secret(at("project", path), {}), path).toBe(true)
    expect(secret(at(".npmrc"), {})).toBe(true)
    expect(secret(at(".ssh", "photo.png"), {})).toBe(true)
  })

  it("is an agent's or a tool's login, an environment, or a shell's history", () => {
    const logins = [
      join(".claude", ".credentials.json"),
      join(".codex", "auth.json"),
      join(".config", "gh", "hosts.yml"),
      join(".config", "gcloud", "application_default_credentials.json"),
      join(".cargo", "credentials.toml"),
      join(".gemini", "oauth_creds.json"),
      ".envrc",
      "prod.env",
      ".bash_history",
      ".zsh_history",
      ".vault-token",
      join(".terraform.d", "credentials.tfrc.json"),
      join(".local", "share", "fish", "fish_history"),
      ".yarnrc.yml",
      join(".config", "rclone", "rclone.conf"),
      ".s3cfg",
      join("AppData", "Roaming", "GitHub CLI", "hosts.yml"),
    ]
    for (const path of logins) expect(secret(at(path), {}), path).toBe(true)
  })

  it("is not a file a login is merely named like, elsewhere, nor code mentioning secrets", () => {
    for (const path of [
      join("src", "i18n", "en", "auth.json"),
      join("deploy", "gcloud", "README.md"),
      "secrets.ts",
    ])
      expect(secret(at("project", path), {}), path).toBe(false)
  })

  it("is a folder of keys whatever the case or the separator its path is written with", () => {
    expect(secret(["C:", "Users", "u", ".SSH", "config"].join("\\"), {})).toBe(true)
    expect(secret("C:/Users/u/.Aws/config", {})).toBe(true)
    expect(secret(["C:", "Users", "u", "project", ".ENV"].join("\\"), {})).toBe(true)
  })

  it("is an agent's login wherever a variable moves the agent's home", ({ directory }) => {
    // Claude Code's, Gemini's and Antigravity's logins are held by their names, so anywhere.
    expect(secret(join(directory, "claude-work", ".credentials.json"), {})).toBe(true)
    expect(secret(join(directory, "gemini-work", ".gemini", "oauth_creds.json"), {})).toBe(true)
    expect(secret(join(directory, "agy-work", "antigravity-oauth-token"), {})).toBe(true)
    expect(secret(join(directory, "agy-work", "mcp_oauth_tokens.json"), {})).toBe(true)
    expect(secret(join(directory, "gemini-work", "mcp-oauth-tokens.json"), {})).toBe(true)
    // Codex's is too plain a name for that: the variable says where its home is.
    const home = folder(directory, "codex-work", ["auth.json"])
    expect(secret(join(home, "auth.json"), {})).toBe(false)
    expect(secret(join(home, "auth.json"), { CODEX_HOME: home })).toBe(true)
    expect(secret(join(home, "AUTH.JSON"), { CODEX_HOME: home + sep })).toBe(true)
    // Only the login: the rest of the home shows as any file.
    expect(secret(join(home, "config.toml"), { CODEX_HOME: home })).toBe(false)
    expect(secret(join(home, "nested", "auth.json"), { CODEX_HOME: home })).toBe(false)
  })

  it("is an agent's login in a home told by what the agent keeps there", ({ directory }) => {
    // A home moved for one terminal alone, or a copy of one: no variable the runner reads names it.
    for (const mark of ["config.toml", "history.jsonl", "version.json"]) {
      const home = folder(directory, `home-with-${mark}`, ["auth.json", mark])
      expect(secret(join(home, "auth.json"), {}), mark).toBe(true)
    }
    const home = folder(directory, "home-with-sessions", ["auth.json"])
    folder(home, "sessions")
    expect(secret(join(home, "auth.json"), {})).toBe(true)
    // A file merely named like the login, among files of another kind, is not.
    const messages = folder(directory, "en", ["auth.json", "common.json"])
    expect(secret(join(messages, "auth.json"), {})).toBe(false)
  })

  it.skipIf(process.platform === "win32")(
    "is a login in a home a variable names through a link",
    ({ directory }) => {
      const home = folder(directory, "codex-real", ["auth.json"])
      const link = join(directory, "codex-link")
      symlinkSync(home, link)
      // Asked by the resolved path, as a file an agent shows is, and as the variable wrote it.
      expect(secret(join(home, "auth.json"), { CODEX_HOME: link })).toBe(true)
      expect(secret(join(link, "auth.json"), { CODEX_HOME: link })).toBe(true)
      expect(secret(join(home, "hosts.yml"), { GH_CONFIG_DIR: link })).toBe(true)
    },
  )

  it("is a tool's login wherever a variable moves the tool's folder", ({ directory }) => {
    const moved = folder(directory, "moved")
    expect(secret(join(moved, "hosts.yml"), {})).toBe(false)
    expect(secret(join(moved, "hosts.yml"), { GH_CONFIG_DIR: moved })).toBe(true)
    expect(secret(join(moved, "config.yml"), { GH_CONFIG_DIR: moved })).toBe(false)
    for (const variable of ["GNUPGHOME", "AZURE_CONFIG_DIR", "DOCKER_CONFIG", "CLOUDSDK_CONFIG"]) {
      expect(secret(join(moved, "config.json"), {}), variable).toBe(false)
      expect(secret(join(moved, "config.json"), { [variable]: moved }), variable).toBe(true)
      expect(secret(join(moved, "deep", "er", "x.db"), { [variable]: moved }), variable).toBe(true)
      // Beside the folder, or in one whose name merely starts as it does, nothing is held.
      expect(secret(join(directory, "notes.txt"), { [variable]: moved }), variable).toBe(false)
      expect(secret(join(`${moved}-too`, "notes.txt"), { [variable]: moved }), variable).toBe(false)
    }
  })

  it("is the one file a variable names as a tool's login", ({ directory }) => {
    const file = join(directory, "work-account")
    const files = [
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
    expect(secret(file, {})).toBe(false)
    for (const variable of files) {
      expect(secret(file, { [variable]: file }), variable).toBe(true)
      expect(secret(join(directory, "other"), { [variable]: file }), variable).toBe(false)
    }
    // kubectl merges every file of its list.
    const second = join(directory, "staging")
    const list = [join(directory, "first"), second].join(delimiter)
    expect(secret(second, { KUBECONFIG: list })).toBe(true)
  })

  it("holds nothing more for a variable that names no one place", ({ directory }) => {
    const { root } = parse(directory)
    // Relative, to a folder only the tool knows: never read against the runner's own.
    const here = process.cwd()
    for (const variable of secretVariables) {
      expect(secret(join(here, "notes.txt"), { [variable]: "" }), variable).toBe(false)
      for (const name of ["notes.txt", "auth.json", "hosts.yml"]) {
        expect(secret(join(here, name), { [variable]: "." }), variable).toBe(false)
        expect(secret(join(here, "moved", name), { [variable]: "moved" }), variable).toBe(false)
        // A filesystem's root is no tool's folder.
        expect(secret(join(root, name), { [variable]: root }), variable).toBe(false)
      }
      expect(secret(join(here, "moved"), { [variable]: "moved" }), variable).toBe(false)
    }
  })

  it("never holds the person's whole home for a variable that names it", ({ directory }) => {
    const work = join(homedir(), "project", "notes.txt")
    for (const variable of ["GNUPGHOME", "AZURE_CONFIG_DIR", "DOCKER_CONFIG", "CLOUDSDK_CONFIG"]) {
      expect(secret(work, { [variable]: homedir() }), variable).toBe(false)
      expect(secret(work, { [variable]: dirname(homedir()) }), variable).toBe(false)
      // A folder inside it still is the tool's.
      const inside = join(homedir(), "project")
      expect(secret(work, { [variable]: inside }), variable).toBe(true)
    }
    expect(secret(join(directory, "notes.txt"), { DOCKER_CONFIG: homedir() })).toBe(false)
  })

  it("reads a variable's name and a path in any case, as Windows does", ({ directory }) => {
    const home = folder(directory, "Codex-Work", ["auth.json"])
    expect(secret(join(home, "auth.json"), { codex_home: home.toUpperCase() })).toBe(true)
    expect(secret(join(home, "hosts.yml").toLowerCase(), { Gh_Config_Dir: home })).toBe(true)
    // The name as the tool reads it comes first.
    const other = folder(directory, "other")
    const both = { CODEX_HOME: other, codex_home: home }
    expect(secret(join(other, "auth.json"), both)).toBe(true)
  })

  it("judges many files by one reading of the environment", ({ directory }) => {
    const home = folder(directory, "codex-work")
    const env = { CODEX_HOME: home, KUBECONFIG: join(directory, "cluster") }
    const held = secrets(env)
    env.CODEX_HOME = join(directory, "elsewhere")
    expect(held(join(home, "auth.json"))).toBe(true)
    expect(held(join(directory, "cluster"))).toBe(true)
    expect(held(join(directory, "notes.txt"))).toBe(false)
  })

  it("names every variable it reads, for whoever gathers the person's environment", () => {
    expect([...secretVariables].toSorted()).toEqual([
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AZURE_CONFIG_DIR",
      "CLOUDSDK_CONFIG",
      "CODEX_HOME",
      "DOCKER_CONFIG",
      "GH_CONFIG_DIR",
      "GNUPGHOME",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "HISTFILE",
      "KUBECONFIG",
      "NETRC",
      "NPM_CONFIG_USERCONFIG",
      "PGPASSFILE",
      "RCLONE_CONFIG",
    ])
  })
})
