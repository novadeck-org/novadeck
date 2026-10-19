import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import { hashPaths, type PathRule } from "./paths.js"
import { createRedactor } from "./redact.js"

const salt = "f3a9c1e07b2d4e6f8a0b1c2d3e4f5a6b"

/** What `hashPaths` writes for a name, as a test spells it out. */
const h = (name: string, extension = ""): string =>
  `#${createHmac("sha256", salt).update(name).digest("hex").slice(0, 8)}${extension}`

const linux = {
  home: "/home/ana",
  user: "ana",
  places: {
    userData: "/home/ana/.config/novadeck",
    logs: "/home/ana/.config/novadeck/logs",
    install: "/tmp/.mount_NovadeAbC123",
  },
  salt,
}
const mac = {
  home: "/Users/ana.lopez",
  user: "ana.lopez",
  places: {
    userData: "/Users/ana.lopez/Library/Application Support/novadeck",
    logs: "/Users/ana.lopez/Library/Logs/novadeck",
    install: "/Applications/Novadeck.app",
  },
  salt,
}
const windows = {
  home: "C:\\Users\\Ana Lopez",
  user: "Ana Lopez",
  places: {
    userData: "C:\\Users\\Ana Lopez\\AppData\\Roaming\\novadeck",
    install: "C:\\Users\\Ana Lopez\\AppData\\Local\\Programs\\novadeck",
  },
  salt,
}

describe("hashPaths", () => {
  const cases: readonly (readonly [string, PathRule, string, string])[] = [
    // Linux
    ["a project file", linux, "/home/ana/acme/billing.ts", `~/${h("acme")}/${h("billing", ".ts")}`],
    ["home alone", linux, "cwd /home/ana", "cwd ~"],
    ["another person's home", linux, "/home/bob/x", `/home/${h("bob")}/${h("x")}`],
    [
      "the app's data",
      linux,
      "/home/ana/.config/novadeck/workspace.sqlite",
      "<userData>/workspace.sqlite",
    ],
    [
      "the logs, inside the app's data",
      linux,
      "/home/ana/.config/novadeck/logs/host.log",
      "<logs>/host.log",
    ],
    [
      "the mounted AppImage",
      linux,
      "/tmp/.mount_NovadeAbC123/resources/app.asar/out/main/index.js",
      "<install>/resources/app.asar/out/main/index.js",
    ],
    ["a system file", linux, "spawn /usr/bin/zsh ENOENT", "spawn /usr/bin/zsh ENOENT"],
    [
      "a tool under home, by its well-known folders and version",
      linux,
      "spawn /home/ana/.nvm/versions/node/v22.3.0/bin/node ENOENT",
      "spawn ~/.nvm/versions/node/v22.3.0/bin/node ENOENT",
    ],
    [
      "a program the app names readable",
      { ...linux, readable: ["claude"] },
      "spawn /home/ana/.local/bin/claude ENOENT",
      "spawn ~/.local/bin/claude ENOENT",
    ],
    [
      "a company tool under /opt",
      linux,
      "/opt/acme-internal-tool/bin/sync",
      `/opt/${h("acme-internal-tool")}/bin/${h("sync")}`,
    ],
    ["the proc tree", linux, "/proc/1234/status", "/proc/1234/status"],
    [
      "a temporary file",
      linux,
      "/tmp/claude-1000/x.json",
      `/tmp/${h("claude-1000")}/${h("x", ".json")}`,
    ],
    ["an unknown root", linux, "/data/acme/x", `/${h("data")}/${h("acme")}/${h("x")}`],
    [
      "a package inside a project",
      linux,
      "/home/ana/acme/node_modules/.pnpm/zod@4.1.0/node_modules/zod/index.js",
      `~/${h("acme")}/node_modules/.pnpm/zod@4.1.0/node_modules/zod/index.js`,
    ],
    [
      "a stack frame",
      linux,
      "    at save (/home/ana/acme/src/store.ts:41:7)",
      `    at save (~/${h("acme")}/${h("src")}/${h("store", ".ts")}:41:7)`,
    ],
    [
      "an error message",
      linux,
      "ENOENT: no such file or directory, open '/home/ana/acme/.env'",
      `ENOENT: no such file or directory, open '~/${h("acme")}/${h(".env")}'`,
    ],
    [
      "a file address",
      linux,
      "file:///home/ana/acme/page.html",
      `file://~/${h("acme")}/${h("page", ".html")}`,
    ],
    ["a folder with a space", linux, "~/My Project/a.md", `~/${h("My Project")}/${h("a", ".md")}`],
    [
      "a web address",
      linux,
      "GET https://github.com/acme/billing/releases",
      "GET https://github.com/acme/billing/releases",
    ],
    ["a ratio, and a word with a slash", linux, "3/4 done and/or failed", "3/4 done and/or failed"],
    [
      "a quoted path with spaces, as Node's errors write one",
      linux,
      "ENOENT: no such file or directory, open '/home/ana/Client Docs/Acme Plan.md'",
      `ENOENT: no such file or directory, open '~/${h("Client Docs")}/${h("Acme Plan", ".md")}'`,
    ],
    [
      "a quoted stack frame",
      linux,
      'at "/home/ana/acme/a b.ts:4:2"',
      `at "~/${h("acme")}/${h("a b", ".ts")}:4:2"`,
    ],
    [
      "an AppImage's mount from another launch",
      linux,
      "    at load (/tmp/.mount_novadePBCjme/resources/app.asar/out/main/index.js:12:3)",
      "    at load (/tmp/.mount_novadePBCjme/resources/app.asar/out/main/index.js:12:3)",
    ],
    ["a WSL drive", linux, "/mnt/c/Users/Bob/acme", `/mnt/c/Users/${h("bob")}/${h("acme")}`],
    // macOS
    [
      "a trailing name with spaces",
      mac,
      "/Users/ana.lopez/Documents/Client Acme Plan.md",
      `~/${h("Documents")}/${h("Client Acme Plan", ".md")}`,
    ],
    ["a project file", mac, "/Users/ana.lopez/acme/a.swift", `~/${h("acme")}/${h("a", ".swift")}`],
    [
      "the app's data, with a space",
      mac,
      "/Users/ana.lopez/Library/Application Support/novadeck/workspace.sqlite",
      "<userData>/workspace.sqlite",
    ],
    [
      "the app bundle",
      mac,
      "/Applications/Novadeck.app/Contents/Resources/app.asar/out/main/index.js:12:3",
      "<install>/Contents/Resources/app.asar/out/main/index.js:12:3",
    ],
    [
      "a system framework",
      mac,
      "/System/Library/Frameworks/AppKit",
      "/System/Library/Frameworks/AppKit",
    ],
    ["a volume", mac, "/Volumes/Backup/acme", `/Volumes/${h("Backup")}/${h("acme")}`],
    [
      "a temporary folder",
      mac,
      "/private/var/folders/xy/T/novadeck-setup",
      `/private/${h("var")}/${h("folders")}/${h("xy")}/${h("T")}/${h("novadeck-setup")}`,
    ],
    // Windows
    [
      "a project file",
      windows,
      "C:\\Users\\Ana Lopez\\acme\\billing.ts",
      `~\\${h("acme")}\\${h("billing", ".ts")}`,
    ],
    [
      "home with forward slashes and another case",
      windows,
      "c:/users/ana lopez/acme",
      `~/${h("acme")}`,
    ],
    [
      "the app's data",
      windows,
      "C:\\Users\\Ana Lopez\\AppData\\Roaming\\novadeck\\workspace.sqlite",
      "<userData>\\workspace.sqlite",
    ],
    [
      "a synced folder and a document with spaces",
      { ...windows, home: "C:\\Users\\ana", user: "ana" },
      "C:\\Users\\ana\\OneDrive - Acme\\Q3 Plan.docx",
      `~\\${h("onedrive - acme")}\\${h("q3 plan", ".docx")}`,
    ],
    [
      "the installed app, by its well-known folders and a name the app reads",
      { ...windows, places: {}, readable: ["novadeck"] },
      "C:\\Users\\Ana Lopez\\AppData\\Local\\Programs\\novadeck\\Novadeck.exe",
      "~\\AppData\\Local\\Programs\\novadeck\\Novadeck.exe",
    ],
    ["the system", windows, "C:\\Windows\\System32\\reg.exe", "C:\\Windows\\System32\\reg.exe"],
    [
      "Program Files",
      windows,
      "C:\\Program Files (x86)\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe",
    ],
    [
      "another drive",
      windows,
      "D:\\Work\\Acme\\x.ts",
      `D:\\${h("work")}\\${h("acme")}\\${h("x", ".ts")}`,
    ],
    ["another person's profile", windows, "C:\\Users\\Bob\\x", `C:\\Users\\${h("bob")}\\${h("x")}`],
    [
      "a stack frame",
      windows,
      "at run (D:\\acme\\src\\main.ts:3:9)",
      `at run (D:\\${h("acme")}\\${h("src")}\\${h("main", ".ts")}:3:9)`,
    ],
    [
      "a file address",
      windows,
      "file:///D:/acme/index.html",
      `file:///D:/${h("acme")}/${h("index", ".html")}`,
    ],
    [
      "a share",
      windows,
      "\\\\fileserver\\finance\\q3.xlsx",
      `\\\\${h("fileserver")}\\${h("finance")}\\${h("q3", ".xlsx")}`,
    ],
    [
      "a WSL share",
      windows,
      "\\\\wsl$\\Ubuntu\\home\\bob\\acme",
      `\\\\wsl$\\Ubuntu\\home\\${h("bob")}\\${h("acme")}`,
    ],
    [
      "a WSL share by its newer name",
      windows,
      "\\\\wsl.localhost\\Debian\\usr\\lib\\tool",
      "\\\\wsl.localhost\\Debian\\usr\\lib\\tool",
    ],
  ]

  for (const [what, rule, text, written] of cases)
    it(`writes ${what} (${rule.home})`, () => {
      expect(hashPaths(text, rule)).toBe(written)
    })

  it("hashes a name the same wherever it appears", () => {
    const once = hashPaths("/home/ana/acme/a.ts and /home/ana/acme/b.ts", linux)
    expect(once).toBe(`~/${h("acme")}/${h("a", ".ts")} and ~/${h("acme")}/${h("b", ".ts")}`)
  })

  it("hashes otherwise with another salt", () => {
    expect(hashPaths("/home/ana/acme", { ...linux, salt: "other" })).not.toBe(`~/${h("acme")}`)
  })

  it("leaves a path it wrote as it is", () => {
    const once = hashPaths("/home/ana/acme/a.ts", linux)
    expect(hashPaths(once, linux)).toBe(once)
  })

  it("writes the app's frames, where its install is told, as <install>", () => {
    const rule = { ...linux, places: { install: "/tmp/.mount_novadePBCjme" } }
    expect(
      hashPaths("at f (/tmp/.mount_novadePBCjme/resources/app.asar/out/main/index.js:12:3)", rule),
    ).toBe("at f (<install>/resources/app.asar/out/main/index.js:12:3)")
  })

  it("writes a folder named as the account as <user>", () => {
    expect(hashPaths("/mnt/c/Users/ana/x", linux)).toBe(`/mnt/c/Users/<user>/${h("x")}`)
  })
})

describe("createRedactor", () => {
  const redact = createRedactor({
    ...linux,
    secretNames: ["NOVADECK_TOKEN"],
    readableUrls: ["*.novadeck.dev"],
    secrets: ["c0ffee-held-secret-value"],
  })

  const cases: readonly (readonly [string, string, string])[] = [
    ["a held secret", "token c0ffee-held-secret-value sent", "token <secret> sent"],
    ["a named variable", "NOVADECK_TOKEN=abc123 pnpm dev", "NOVADECK_TOKEN=<redacted> pnpm dev"],
    ["a named variable, quoted", 'NOVADECK_TOKEN: "abc123"', 'NOVADECK_TOKEN: "<redacted>"'],
    [
      "a URL's credentials",
      "fetch https://ana:hunter2@git.acme.dev/x failed",
      `fetch https://<redacted>@${h("git.acme.dev")}.dev/${h("x")} failed`,
    ],
    ["a bearer token", "Authorization: Bearer abc.def.ghi", "Authorization: <redacted>"],
    ["a bare bearer token", "sent bearer a1b2c3d4e5", "sent bearer <redacted>"],
    ["a cookie", "cookie=sid=abc123; path=/", "cookie=<redacted>; path=/"],
    ["an Anthropic key", "key sk-ant-api03-abcdefghijklmnopqrstuv", "key <secret>"],
    ["an OpenAI key", "sk-proj-abcdefghijklmnop1234", "<secret>"],
    ["a GitHub token", "using gho_abcdefghijklmnopqrstuvwxyz0123", "using <secret>"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0123456789_abcdefghij", "<secret>"],
    ["an AWS key", "AKIAIOSFODNN7EXAMPLE rejected", "<secret> rejected"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "<secret>"],
    [
      "a JSON web token",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "jwt <secret>",
    ],
    [
      "secrets in a query",
      "GET https://api.novadeck.dev/v1?user=7&token=abc123&api_key=zzz&page=2",
      "GET https://api.novadeck.dev/v1?user=7&token=<redacted>&api_key=<redacted>&page=2",
    ],
    ["a password setting", "password=hunter2 rejected", "password=<redacted> rejected"],
    ["secrets in JSON", '{"accessToken":"abc","id":3}', '{"accessToken":"<redacted>","id":3}'],
    ["an email address", "signed in as ana.lopez+dev@acme.co.uk.", "signed in as <email>."],
    ["the account name as a word", "ana's session for ana", "<user>'s session for <user>"],
    ["the account name inside another word", "banana analytics", "banana analytics"],
    [
      "a stack with a home path",
      "Error: no\n    at read (/home/ana/acme/src/a.ts:1:2)\n    at node:internal/fs:3:4",
      `Error: no\n    at read (~/${h("acme")}/${h("src")}/${h("a", ".ts")}:1:2)\n    at node:internal/fs:3:4`,
    ],
    ["a Google key", "key=AIzaSyA1234567890abcdefghijklmnopqrstuv", "key=<secret>"],
    ["a bare Google key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "<secret>"],
    ["a Stripe key", "sk_live_abcdefghijklmnop1234", "<secret>"],
    ["a Stripe restricted key", "rk_test_abcdefghijklmnop1234", "<secret>"],
    ["a Hugging Face token", "hf_abcdefghijklmnopqrstuvwxyzABCDEF", "<secret>"],
    [
      "a private key",
      "read -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY----- done",
      "read <secret> done",
    ],
    ["a private key cut short", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA", "<secret>"],
    [
      "a private repository, quoted as Git does",
      "fatal: repository 'https://github.com/acme/secret-repo.git/' not found",
      `fatal: repository 'https://github.com/${h("acme")}/${h("secret-repo", ".git")}/' not found`,
    ],
    [
      "a remote over SSH",
      "git@github.com:acme/secret.git rejected",
      `git@github.com:${h("acme")}/${h("secret", ".git")} rejected`,
    ],
    [
      "a remote over ssh://",
      "ssh://git@github.com/acme/secret.git",
      `ssh://<redacted>@github.com/${h("acme")}/${h("secret", ".git")}`,
    ],
    ["an npm package", "react@19.3.1 and @novadeck/log", "react@19.3.1 and @novadeck/log"],
  ]

  for (const [what, text, written] of cases)
    it(`replaces ${what}`, () => {
      expect(redact(text)).toBe(written)
    })

  it("leaves a short or ordinary account name in the text", () => {
    expect(createRedactor({ user: "dev", salt })("dev build")).toBe("dev build")
    expect(createRedactor({ user: "al", salt })("al dente")).toBe("al dente")
  })

  it("writes the same text the same twice", () => {
    const text = "open /home/ana/acme/a.ts as ana@acme.dev with token=abc"
    expect(redact(redact(text))).toBe(redact(text))
  })
})
