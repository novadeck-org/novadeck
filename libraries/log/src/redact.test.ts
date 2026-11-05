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

// A growth of this or more is no linear time: between linear's 1 and a quadratic's 10.
const superlinear = 3

/**
 * The milliseconds this thread has run: what a busy machine cannot stretch, as it does the
 * time on the clock. Linux counts it in steps of a kernel tick, 1 to 4 ms, and macOS finer.
 * Windows counts it in steps of some 16 ms, too coarse for these samples, so there the
 * clock is read.
 */
const spent = (): number => {
  if (process.platform === "win32") return performance.now()
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

/**
 * How many times longer `work` takes on a text of `length` than on a tenth of it ten times
 * over: about 1 where its time is linear in the length, about 10 where it is quadratic.
 *
 * Two things keep a busy machine out of it. The time is the thread's own (see `spent`): by
 * the clock, a sample of a millisecond fits in one of the scheduler's time slices and runs
 * at full speed while a longer one shares its core, which read as 108 times the time for
 * ten times the text on a loaded macOS runner. And the two sides are the same amount of
 * work where it is linear, so what does slow the thread slows them alike.
 *
 * The whole text is passed over until 30 ms are spent, and a side is that many passes over
 * it, or ten times as many over its tenth: several steps of the coarsest clock, which would
 * read a side of a millisecond as nothing. Each round times one side straight after the
 * other, and the middle round's ratio counts (the higher of two middle ones), so a load
 * that comes or goes in one round does not decide. Seven rounds at most: it ends after
 * three or five that read under `superlinear`, or with the round in which five seconds
 * have passed, as the first round of a quadratic may take.
 */
const growth = (
  work: (text: string) => unknown,
  text: (length: number) => string,
  length: number,
): { times: number; rounds: readonly number[] } => {
  const part = text(length / 10)
  const whole = text(length)
  const timed = (run: () => void): number => {
    const started = spent()
    run()
    return spent() - started
  }
  // Compiled before anything is timed.
  work(part)
  const began = performance.now()
  let passes = 0
  let once = timed(() => {
    for (const started = spent(); spent() - started < 30; passes++) work(whole)
  })
  const rounds: number[] = []
  for (;;) {
    const parts = timed(() => {
      for (let pass = 0; pass < 10 * passes; pass++) work(part)
    })
    rounds.push(once / parts)
    const times = rounds.toSorted((a, b) => a - b)[Math.floor(rounds.length / 2)] ?? Infinity
    const settled = rounds.length % 2 === 1 && rounds.length >= 3 && times < superlinear
    if (settled || rounds.length === 7 || performance.now() - began >= 5_000)
      return { times, rounds }
    once = timed(() => {
      for (let pass = 0; pass < passes; pass++) work(whole)
    })
  }
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
    [
      "a URL's credentials after a long word",
      `${"x".repeat(40)}https://ana:hunter2@127.0.0.1/`,
      `${"x".repeat(40)}https://<redacted>@127.0.0.1/`,
    ],
    [
      "what JSON.parse quotes from the middle of its input, in another error's message",
      'Settings could not be read: Unexpected token \'h\', ..."assword": hunter2xyz"... is not valid JSON',
      "Settings could not be read: Unexpected token (input withheld)",
    ],
    [
      "what JSON.parse quotes across a line break, in another error's message",
      "Read failed: Unexpected token 'a', \"ab\ncd private\" is not valid JSON",
      "Read failed: Unexpected token (input withheld)",
    ],
    ["an address after another @", "a@b@c.com", "a@<email>"],
    [
      "what JSON.parse quotes, in another error's message",
      "Settings could not be read: Unexpected token 'm', \"my private\"... is not valid JSON",
      "Settings could not be read: Unexpected token (input withheld)",
    ],
  ]

  for (const [what, text, written] of cases)
    it(`replaces ${what}`, () => {
      expect(redact(text)).toBe(written)
    })

  it.each([
    ["a non-ASCII local part", "contact zoë@example.com now", "contact <email> now"],
    ["a decomposed accent", "contact zoe\u0308@example.com now", "contact <email> now"],
    ["a Polish name", "od paweł@firma.pl i łukasz@firma.pl", "od <email> i <email>"],
    ["a non-ASCII domain", "ana@exämple.de failed", "<email> failed"],
    ["an address in another script", "иван@пример.рф", "<email>"],
    ["a host alone", "sent to ana@intranet, then ana@devbox.", "sent to <email>, then <email>."],
    ["an address at a sentence's end", "write to ana@acme.dev.", "write to <email>."],
  ])("replaces an email address with %s", (_what, text, written) => {
    expect(redact(text)).toBe(written)
  })

  it.each([
    ["a package's version", "installed react@19.3.1 and @types/node@26.6.6"],
    ["a package's tag", "npx vite@latest and pnpm add vitest@beta, foo@dev and foo@preview"],
    ["a package's tagged version", "pkg@v1.2.3"],
    ["a workspace package", "@novadeck/log@workspace:*"],
    ["a package in the pnpm store", "node_modules/.pnpm/vite@7.1.2_@types+node@26.6.6/x"],
    ["an image's digest", "node@sha256:0123456789abcdef"],
    ["a reflog entry", "HEAD@{1} and stash@{0}"],
    ["a stack frame's address", "render@http://127.0.0.1:41235/assets/index.js:1:2"],
    ["a scoped package alone", "@scope/name"],
  ])("keeps %s, which is no email address", (_what, text) => {
    expect(redact(text)).toBe(text)
  })

  // Each took seconds at 200,000 characters before: a pattern that looked again from each
  // character of a long run. What holds is linear time, not a speed a slow or busy machine
  // may not have: see `growth`.
  it.each([
    ["a long run of letters", (length: number) => "A".repeat(length)],
    ["a long hex run", (length: number) => "0123456789abcdef".repeat(length / 16)],
    ["a long dotted run before an @", (length: number) => `${"a.".repeat(length / 2)}@x`],
    ["a long dashed host", (length: number) => `a@${"b-".repeat(length / 2)}`],
    ["a long run before a remote's path", (length: number) => `a@b.c:${"d".repeat(length)}`],
    ["a syntax error with a long gap", (length: number) => `SyntaxError: ${" ".repeat(length)}x"`],
    ["many syntax errors with no quote", (length: number) => "SyntaxError: ".repeat(length / 13)],
    ["many remote-like parts", (length: number) => "a@b.c:".repeat(length / 6)],
  ])(
    "redacts %s in time linear in its length, to 200,000 characters",
    (_what, text) => {
      const { times, rounds } = growth(redact, text, 200_000)
      expect(
        times,
        `200,000 against ten of 20,000, by round: ${rounds.map((round) => round.toFixed(1)).join(", ")}`,
      ).toBeLessThan(superlinear)
    },
    60_000,
  )

  // The measure itself, on the email pattern as it was when it looked again from each
  // character of a run: were it to read this as linear, the cases above would guard nothing.
  // Not on Windows, where the clock is read: a quadratic's two sides are not the same work,
  // so a busy machine stretches the short one more, and read this as 1.2 once.
  it.skipIf(process.platform === "win32")(
    "reads a pattern that looks again from each character as no linear time",
    () => {
      const rescanning =
        /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b(?!:[\w#~./<])/g
      const { times, rounds } = growth(
        (text) => text.replace(rescanning, "<email>"),
        (length) => "A".repeat(length),
        15_000,
      )
      expect(
        times,
        `15,000 against ten of 1,500, by round: ${rounds.map((round) => round.toFixed(1)).join(", ")}`,
      ).toBeGreaterThan(superlinear)
    },
    60_000,
  )

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
