import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import { createRedactor } from "./redact.js"

const salt = "f3a9c1e07b2d4e6f8a0b1c2d3e4f5a6b"

/** What the redactor writes for a name or a host, as a test spells it out. */
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

describe("createRedactor", () => {
  const redact = createRedactor({
    ...linux,
    secretNames: ["NOVADECK_TOKEN"],
    readableUrls: ["*.novadeck.dev", "github.com/novadeck-org"],
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
    ["a bearer token", "Authorization: Bearer abc.def.ghi", "Authorization: <secret>"],
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
      "GET https://api.novadeck.dev/v1?…",
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
    ["a Google key", "key=AIzaSyA1234567890abcdefghijklmnopqrstuv", "key=<redacted>"],
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
    [
      "a URL's password with no user",
      "redis://:hunter2@127.0.0.1:6379/0",
      "redis://<redacted>@127.0.0.1:6379/0",
    ],
    [
      "a password as YAML writes it",
      "password: hunter2 was refused",
      "password: <redacted> was refused",
    ],
    ["a token as a dump writes it", "auth_token: abcdef1234567890", "auth_token: <redacted>"],
    [
      "a password on a command line",
      "mysql --password hunter2 -h db",
      "mysql --password <redacted> -h db",
    ],
    [
      "a host Node's errors name bare",
      "getaddrinfo ENOTFOUND git.acme.corp",
      `getaddrinfo ENOTFOUND ${h("git.acme.corp")}.corp`,
    ],
    [
      "an address Node's errors name bare",
      "connect ECONNREFUSED 10.20.30.40:5432",
      `connect ECONNREFUSED ${h("10.20.30.40")}:5432`,
    ],
    [
      "the loopback Node's errors name",
      "connect ECONNREFUSED 127.0.0.1:5173",
      "connect ECONNREFUSED 127.0.0.1:5173",
    ],
    [
      "what a syntax error printed elsewhere quotes",
      "Uncaught SyntaxError: Unexpected token 'm', \"meet at Acme\" is not valid JSON",
      "Uncaught SyntaxError: Unexpected token (input withheld)",
    ],
    [
      "an INI secret",
      "aws_secret_access_key = wJalrXUtnFEMI",
      "aws_secret_access_key = <redacted>",
    ],
    ["a password variable", "DB_PASS=hunter2 npm start", "DB_PASS=<redacted> npm start"],
    [
      "a session in JSON",
      '{"session":"abc","pass":"def"}',
      '{"session":"<redacted>","pass":"<redacted>"}',
    ],
    ["a Google OAuth token", "Bearer-less ya29.a0AfH6SMBabcdefghijklmnop", "Bearer-less <secret>"],
    [
      "a host ssh and curl name bare",
      "ssh: Could not resolve hostname git.acme.corp: Name or service not known",
      `ssh: Could not resolve hostname ${h("git.acme.corp")}.corp: Name or service not known`,
    ],
    [
      "a repository on a forge without its scheme",
      "see github.com/acmecorp/secret-repo and github.com/novadeck-org/novadeck",
      `see github.com/${h("acmecorp")}/${h("secret-repo")} and github.com/novadeck-org/novadeck`,
    ],
    [
      "a file address of a share",
      "file://fileserver.acme.corp/clients/plan.md",
      `file://${h("fileserver.acme.corp")}.corp/${h("clients")}/${h("plan", ".md")}`,
    ],
    ["an npm package", "react@19.3.1 and @novadeck/log", "react@19.3.1 and @novadeck/log"],
  ]

  for (const [what, text, written] of cases)
    it(`replaces ${what}`, () => {
      expect(redact(text)).toBe(written)
    })

  it.each([
    ["a hex segment", "/home/ana/.config/Code/0123456789abcdef0123456789abcdef/bigbank/state.db"],
    ["a token-like segment", "/home/ana/code/sk-learning-notes/bigbank/plan.md"],
    [
      "a token-like Windows segment",
      String.raw`C:\Users\ana\0123456789abcdef0123456789abcdef\bigbank\plan.md`,
    ],
    ["a hex host", "fetch https://0123456789abcdef0123456789abcdef.bigbank.dev/plan failed"],
    ["a token-like host", "getaddrinfo ENOTFOUND sk-abcdefgh.bigbank.dev"],
    ["a hex email address", "reply to 0123456789abcdef0123456789abcdef@reply.bigbank.com failed"],
    ["a hex remote", "git@git.bigbank.dev:0123456789abcdef0123456789abcdef/plan.git"],
  ])("hashes a path or address whole, though %s in it looks like a secret", (_what, text) => {
    expect(redact(text)).not.toMatch(/bigbank|plan\.|state\./)
  })

  it.each([
    [
      "a base64 key with +/ in it",
      "key wJalrXUtnFEMI+/K7MDENGbPxRfiCYEXAMPLEKEY99 loaded",
      /wJalr|K7MD/,
    ],
    ["a pass phrase that starts with the account name", "passphrase: ana.2019!xyz", /2019|xyz/],
  ])("leaves nothing of %s", (_what, text, kept) => {
    expect(redact(text)).not.toMatch(kept)
  })

  it.each([
    ["a diff's added line", "@@ -1 +1 @@\n-/home/ana/old/x\n+/home/ana/new/clientco/x"],
    ["a quoted added path", '"+/home/ana/acme/clientco.md"'],
    ["a Windows path after +", String.raw`+C:\Users\ana\clientco`],
    ["a path after C++", "C++/src/clientco/x"],
  ])("hashes %s", (_what, text) => {
    expect(redact(text)).not.toMatch(/clientco/)
  })

  it("writes placeholders whole, though the account is named as one", () => {
    const named = createRedactor({ ...linux, user: "secret", salt })
    expect(named("token sk-proj-abcdefghijklmnop1234 for secret")).toBe("token <secret> for secret")
  })

  it.each(["PRIVATE_KEY=", "password: ", "--token ", "/tmp/x"])(
    "masks a key block whole after %s",
    (before) => {
      const block =
        "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8w\nabcdefghijklmnop\n-----END PRIVATE KEY-----"
      expect(redact(`${before}${block}`)).not.toMatch(/MIIB|abcdefgh|BEGIN|END/)
    },
  )

  it("writes the account name as <user> beside angle brackets", () => {
    expect(redact("ana> ls")).toBe("<user>> ls")
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
