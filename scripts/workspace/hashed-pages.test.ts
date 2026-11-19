import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { allowsByHash, eolOf, hashedPages, isHashed, policiesOf } from "./hashed-pages.ts"

const root = join(import.meta.dirname, "..", "..")

/** A page with `policy` in a meta tag and one inline script. */
const page = (policy: string): string =>
  [
    "<!doctype html>",
    "<html>",
    "  <head>",
    `    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    "  </head>",
    "  <body>",
    "    <script>",
    "      start()",
    "    </script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n")

const hashed =
  "default-src 'none'; script-src 'sha256-ZiyWc6zVlivXUz6YUNddnUHgwt2sBZKTzoz0bpGCTx8='"

describe("the repository's hashed pages", () => {
  const pages = hashedPages(root)

  it("are found by their policies, the viewer frame's among them", () => {
    expect(pages).toEqual(
      expect.arrayContaining([
        "frontend/ui/public/viewer-frame.html",
        "libraries/viewers/src/frame/frame.html",
      ]),
    )
  })

  // On Windows a page checked out with CRLF hashes differently, and its script never runs (as
  // no PDF drew after #1037 and #1051).
  it("each keep LF line endings on every system", () => {
    expect(
      eolOf(root, pages).filter(({ eol }) => eol !== "lf"),
      "Add each to .gitattributes as `<path> text eol=lf`",
    ).toEqual([])
  })
})

describe("a page's policies", () => {
  it("are what its Content-Security-Policy meta tags hold", () => {
    expect(policiesOf(page(hashed))).toEqual([hashed])
  })

  it("are read whatever the case, quotes or order of the tag's attributes", () => {
    expect(
      policiesOf(
        [
          `<META CONTENT='script-src &apos;self&apos;' HTTP-EQUIV='content-security-policy'>`,
          `<meta content="a > b" http-equiv=Content-Security-Policy>`,
        ].join("\n"),
      ),
    ).toEqual(["script-src 'self'", "a > b"])
  })

  it("leave out other meta tags and a tag in a comment", () => {
    expect(
      policiesOf(
        [
          `<meta charset="utf-8" />`,
          `<meta name="Content-Security-Policy" content="script-src 'sha256-a='" />`,
          `<!-- <meta http-equiv="Content-Security-Policy" content="script-src 'sha256-a='" /> -->`,
        ].join("\n"),
      ),
    ).toEqual([])
  })
})

describe("a policy that allows by hash", () => {
  it.each([
    hashed,
    "script-src-elem 'sha384-abc='",
    "default-src 'sha512-abc='",
    "style-src 'SHA256-abc='",
    "default-src 'self';script-src 'self' 'sha256-abc=' ;",
  ])("is %s", (policy) => {
    expect(allowsByHash(policy)).toBe(true)
  })

  it.each([
    "script-src 'self'",
    "script-src 'nonce-abc='",
    "default-src 'none'; script-src blob: 'wasm-unsafe-eval'",
    "",
  ])("isn't %s", (policy) => {
    expect(allowsByHash(policy)).toBe(false)
  })

  it("makes its page hashed", () => {
    expect(isHashed(page(hashed))).toBe(true)
    expect(isHashed(page("script-src 'self'"))).toBe(false)
    expect(isHashed("<html><script>start()</script></html>")).toBe(false)
  })
})

describe("the check of a repository's hashed pages", () => {
  let repo = ""

  /** Runs git in the scratch repository, apart from this machine's own git config. */
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(repo, "..", "gitconfig"),
      },
    })

  const write = (path: string, text: string): void => {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  beforeEach(() => {
    const folder = mkdtempSync(join(tmpdir(), "hashed-pages-"))
    writeFileSync(join(folder, "gitconfig"), "")
    repo = join(folder, "repo")
    mkdirSync(repo)
    git("init", "-q")
    write("src/frame.html", page(hashed))
    write("src/index.html", page("script-src 'self'"))
    write("notes/frame.html.md", page(hashed))
  })

  afterEach(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true })
  })

  it("finds a new page before it's committed, and only hashed pages", () => {
    expect(hashedPages(repo)).toEqual(["src/frame.html"])
  })

  it("passes a page its .gitattributes keeps LF", () => {
    write(".gitattributes", "src/frame.html text eol=lf\n")
    expect(eolOf(repo, hashedPages(repo))).toEqual([{ path: "src/frame.html", eol: "lf" }])
  })

  it("fails a page with no line of its own", () => {
    write(".gitattributes", "*.md text eol=lf\n")
    expect(eolOf(repo, hashedPages(repo))).toEqual([{ path: "src/frame.html", eol: "unspecified" }])
  })

  it("fails a page moved away from its line", () => {
    write(".gitattributes", "src/frame.html text eol=lf\n")
    git("add", "-A")
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "pages")
    mkdirSync(join(repo, "src", "frame"))
    git("mv", "src/frame.html", "src/frame/frame.html")
    expect(eolOf(repo, hashedPages(repo))).toEqual([
      { path: "src/frame/frame.html", eol: "unspecified" },
    ])
  })

  it("fails a page git checks out with CRLF", () => {
    write(".gitattributes", "*.html text eol=crlf\n")
    expect(eolOf(repo, hashedPages(repo))).toEqual([{ path: "src/frame.html", eol: "crlf" }])
  })
})
