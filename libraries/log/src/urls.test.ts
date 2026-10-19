import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import { hashUrls, type UrlRule } from "./urls.js"

const salt = "f3a9c1e07b2d4e6f8a0b1c2d3e4f5a6b"

/** What `hashUrls` writes for a name or a host, as a test spells it out. */
const h = (name: string, extension = ""): string =>
  `#${createHmac("sha256", salt).update(name).digest("hex").slice(0, 8)}${extension}`

const rule: UrlRule = {
  salt,
  readableUrls: ["*.novadeck.dev", "github.com/novadeck-org", "huggingface.co/unsloth"],
}

describe("hashUrls", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      "a release of the app's own",
      "GET https://github.com/novadeck-org/novadeck/releases/download/v1.2.3/latest.yml",
      "GET https://github.com/novadeck-org/novadeck/releases/download/v1.2.3/latest.yml",
    ],
    ["the app's site", "https://novadeck.dev/docs?x=1#top", "https://novadeck.dev/docs?x=1#top"],
    [
      "a subdomain of it",
      "https://api.novadeck.dev/v1/report",
      "https://api.novadeck.dev/v1/report",
    ],
    [
      "a model the app downloads",
      "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/q.gguf",
      "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/q.gguf",
    ],
    [
      "another repository on a public forge",
      "https://github.com/acme/secret-repo.git/",
      `https://github.com/${h("acme")}/${h("secret-repo", ".git")}/`,
    ],
    [
      "another organization whose name starts as the app's",
      "https://github.com/novadeck-org-fork/x",
      `https://github.com/${h("novadeck-org-fork")}/${h("x")}`,
    ],
    [
      "a company's host, keeping its top-level domain",
      "https://git.acme.corp/team/app.git",
      `https://${h("git.acme.corp")}.corp/${h("team")}/${h("app", ".git")}`,
    ],
    [
      "an address by its IP",
      "http://10.0.0.5:8080/admin",
      `http://${h("10.0.0.5")}:8080/${h("admin")}`,
    ],
    [
      "the loopback, keeping its port",
      "http://127.0.0.1:5173/customers/acme",
      `http://127.0.0.1:5173/${h("customers")}/${h("acme")}`,
    ],
    [
      "a query and a fragment, dropped, and the sentence's end kept",
      "see https://acme.io/a?b=c#d.",
      `see https://${h("acme.io")}.io/${h("a")}?…#….`,
    ],
    [
      "a remote over SSH on a public forge",
      "git@github.com:acme/secret.git",
      `git@github.com:${h("acme")}/${h("secret", ".git")}`,
    ],
    [
      "a remote over SSH with its own user, on a company's host",
      "deploy@git.acme.corp:team/app.git",
      `<redacted>@${h("git.acme.corp")}.corp:${h("team")}/${h("app", ".git")}`,
    ],
    [
      "the app's own remote",
      "git@github.com:novadeck-org/novadeck.git",
      "git@github.com:novadeck-org/novadeck.git",
    ],
    [
      "a host and port that is no remote",
      "connect ana@host.example:22",
      "connect ana@host.example:22",
    ],
    ["a file address, which paths take", "file:///home/ana/x", "file:///home/ana/x"],
  ]

  for (const [what, text, written] of cases)
    it(`writes ${what}`, () => {
      expect(hashUrls(text, rule)).toBe(written)
    })

  it("names public forges as given", () => {
    expect(
      hashUrls("https://codeberg.org/acme/x", { ...rule, publicHosts: ["codeberg.org"] }),
    ).toBe(`https://codeberg.org/${h("acme")}/${h("x")}`)
  })
})
