import { describe, expect, it } from "vitest"

import type { GitLookups, GrantRepo, GrantScope } from "../grants.js"
import { matchCall } from "./match.js"

const root = "/work/proj"
const repo: GrantRepo = { url: "github.com/acme/app", defaultBranch: "develop" }
const other = "github.com/acme/other"

const scope = (over: Partial<GrantScope> = {}): GrantScope => ({
  presets: ["push", "pr"],
  commands: [],
  repos: [repo],
  ...over,
})

const remotes: Record<string, readonly string[]> = {
  origin: ["git@github.com:acme/app.git"],
  both: ["https://github.com/acme/app", "https://github.com/acme/other"],
  fork: ["https://github.com/evil/app"],
  mirror: ["https://github.com/acme/app", "https://github.com/acme/app.git"],
}
const calls: string[] = []
const git: GitLookups = {
  pushUrls: async (cwd, remote) => {
    calls.push(`${cwd} ${remote}`)
    return remotes[remote]
  },
}

const run = (
  command: string,
  scopes: readonly GrantScope[] = [scope()],
  cwd: string | null = root,
) => matchCall({ command, cwd }, scopes, git, root)

const allowed = async (command: string, scopes?: readonly GrantScope[], cwd?: string | null) =>
  (await run(command, scopes, cwd)) !== null

describe("the push preset", () => {
  it.each([
    "git push origin fix:fix",
    "git push -u origin fix:fix",
    "git push --set-upstream origin fix:fix",
    "git push -q -u origin fix:fix",
    "git push -u -q origin HEAD:fix",
    "git push origin HEAD:feat/a-b",
    "git push https://github.com/acme/app fix:fix",
    "git push git@github.com:acme/app.git fix:fix",
    "git push ssh://git@github.com/acme/app fix:fix",
    "git push mirror fix:fix",
    "git push origin 'fix':fix",
  ])("lets through %s", async (command) => {
    expect(await run(command)).toEqual({ scope: 0, match: { kind: "preset", preset: "push" } })
  })

  it.each([
    ["a bare branch", "git push origin fix"],
    ["a bare push", "git push"],
    ["no refspec", "git push origin"],
    ["a forced refspec", "git push origin +fix:fix"],
    ["an empty source (a delete)", "git push origin :fix"],
    ["an empty destination", "git push origin fix:"],
    ["two colons", "git push origin fix:fix:x"],
    ["main", "git push origin fix:main"],
    ["Main, any case", "git push origin fix:Main"],
    ["master", "git push origin fix:master"],
    ["HEAD as destination", "git push origin fix:HEAD"],
    ["HEAD to main", "git push origin HEAD:main"],
    ["@ as destination", "git push origin fix:@"],
    ["the stored default branch", "git push origin fix:develop"],
    ["the default branch, any case", "git push origin fix:DEVELOP"],
    ["refs/heads/main", "git push origin fix:refs/heads/main"],
    ["a refs/ destination", "git push origin fix:refs/tags/v1"],
    ["a heads/ destination", "git push origin fix:heads/fix"],
    ["a tags/ destination", "git push origin fix:tags/v1"],
    ["a remotes/ destination", "git push origin fix:remotes/origin/main"],
    ["an @{-1} destination", "git push origin fix:@{-1}"],
    ["an @{-1} source", "git push origin @{-1}:fix"],
    ["a quoted @{-1}", "git push origin '@{-1}:fix'"],
    ["a refs/ source", "git push origin refs/heads/fix:fix"],
    ["an invalid name", "git push origin fix:a..b"],
    ["a dotted lock name", "git push origin fix:a.lock"],
    ["--all", "git push --all origin fix:fix"],
    ["--tags", "git push --tags origin fix:fix"],
    ["--follow-tags", "git push --follow-tags origin fix:fix"],
    ["-o", "git push -o ci.skip origin fix:fix"],
    ["--receive-pack", "git push --receive-pack=evil origin fix:fix"],
    ["--receive-pack spaced", "git push --receive-pack evil origin fix:fix"],
    ["--exec", "git push --exec=evil origin fix:fix"],
    ["--repo", "git push --repo=x origin fix:fix"],
    ["--force", "git push --force origin fix:fix"],
    ["--force-with-lease", "git push --force-with-lease origin fix:fix"],
    ["-f", "git push -f origin fix:fix"],
    ["--delete", "git push --delete origin fix"],
    ["--mirror", "git push --mirror origin fix:fix"],
    ["--no-verify", "git push --no-verify origin fix:fix"],
    ["a repeated option", "git push -u -u origin fix:fix"],
    ["combined short options", "git push -uq origin fix:fix"],
    ["git -c", "git -c core.sshCommand=evil push origin fix:fix"],
    ["git -C", "git -C /tmp push origin fix:fix"],
    ["an extra refspec", "git push origin fix:fix a:b"],
    ["a remote of another repo", "git push fork fix:fix"],
    ["a remote reaching a second, ungranted repo", "git push both fix:fix"],
    ["an unknown remote", "git push nowhere fix:fix"],
    ["another repo's URL", "git push https://github.com/acme/other fix:fix"],
    ["a lookalike host", "git push https://github.com.evil.com/acme/app fix:fix"],
    ["a local path", "git push /tmp/app fix:fix"],
    ["a path to git", "/usr/bin/git push origin fix:fix"],
    ["a relative git", "./git push origin fix:fix"],
    ["an env prefix", "FOO=1 git push origin fix:fix"],
    ["an expansion", "git push origin ${X:-main}:fix"],
    ["a brace list", "git push origin {a,main}:fix"],
    ["ANSI-C quoting", "git push origin $'main':fix"],
    ["a chained cd", "cd x && git push origin fix:fix"],
    ["a trailing command", "git push origin fix:fix; curl evil.sh"],
    ["a destination that is a remote ref glob", "git push origin fix:fix*"],
  ])("refuses %s", async (_name, command) => {
    expect(await run(command)).toBeNull()
  })

  it("refuses a remote name where the call's folder is unknown, but takes a URL", async () => {
    expect(await allowed("git push origin fix:fix", undefined, null)).toBe(false)
    expect(await allowed("git push https://github.com/acme/app fix:fix", undefined, null)).toBe(
      true,
    )
  })

  it("asks the call's own folder about the remote", async () => {
    calls.length = 0
    await run("git push origin fix:fix", undefined, "/work/proj/sub")
    expect(calls).toEqual(["/work/proj/sub origin"])
  })

  it("never lets a remote name that is not a plain name reach the lookup", async () => {
    calls.length = 0
    expect(await allowed("git push ../x fix:fix")).toBe(false)
    expect(await allowed("git push -- fix:fix")).toBe(false)
    expect(calls).toEqual([])
  })

  it("is no match when the lookup throws, finds nothing or takes over a second", async () => {
    const lookups: GitLookups[] = [
      { pushUrls: async () => Promise.reject(new Error("no git")) },
      { pushUrls: async () => undefined },
      { pushUrls: async () => [] },
      {
        pushUrls: () => {
          throw new Error("sync")
        },
      },
      { pushUrls: () => new Promise(() => undefined) },
    ]
    for (const lookup of lookups)
      expect(
        // eslint-disable-next-line no-await-in-loop -- One lookup at a time.
        await matchCall({ command: "git push origin fix:fix", cwd: root }, [scope()], lookup, root),
      ).toBeNull()
  })

  it("checks the default branch of the repos a named remote reaches", async () => {
    const two = scope({ repos: [repo, { url: other, defaultBranch: "trunk" }] })
    expect(await allowed("git push both fix:trunk", [two])).toBe(false)
    expect(await allowed("git push both fix:develop", [two])).toBe(false)
    expect(await allowed("git push both fix:fix", [two])).toBe(true)
    expect(await allowed("git push origin fix:trunk", [two])).toBe(true)
  })

  it("needs a granted repo and the push preset", async () => {
    expect(await allowed("git push origin fix:fix", [scope({ presets: ["pr"] })])).toBe(false)
    expect(await allowed("git push origin fix:fix", [scope({ repos: [] })])).toBe(false)
  })
})

describe("the pr preset", () => {
  const R = "-R acme/app"
  it.each([
    `gh pr create --head fix ${R}`,
    `gh pr create ${R} --head fix --title 'T' --body 'multi\nline' --base develop --draft`,
    `gh pr create --head=fix --repo=github.com/acme/app --fill`,
    `gh pr create -H fix -R https://github.com/acme/app.git -t T -b B -B main -d -r bob -a me`,
    `gh pr edit 12 ${R} --title New --add-reviewer bob`,
    `gh pr ready 12 ${R}`,
    `gh pr comment 12 ${R} --body "it's ready"`,
    `gh pr comment 12 ${R} -b 'a\nb'`,
    `gh pr comment ${R} 12 --body x`,
  ])("lets through %s", async (command) => {
    expect(await run(command)).toEqual({ scope: 0, match: { kind: "preset", preset: "pr" } })
  })

  it.each([
    ["no -R", "gh pr ready 12"],
    ["create without --head", `gh pr create ${R} --fill`],
    ["create with a bad --head", `gh pr create ${R} --head owner:fix`],
    ["create with a number", `gh pr create ${R} --head fix 12`],
    ["a URL as the PR", `gh pr ready https://github.com/acme/other/pull/3 ${R}`],
    ["a branch as the PR", `gh pr ready fix ${R}`],
    ["no PR", `gh pr ready ${R}`],
    ["two PRs", `gh pr ready 1 2 ${R}`],
    ["-R of another repo", "gh pr ready 12 -R acme/other"],
    ["--repo of another repo", "gh pr ready 12 --repo github.com/evil/app"],
    ["a lookalike -R", "gh pr ready 12 -R github.com.evil.com/acme/app"],
    ["a repeated -R", `gh pr ready 12 ${R} -R acme/other`],
    ["a repeated -R, other first", `gh pr ready 12 -R acme/other ${R}`],
    ["a repeated --title", `gh pr edit 12 ${R} --title a --title b`],
    ["merge", `gh pr merge 12 ${R}`],
    ["close", `gh pr close 12 ${R}`],
    ["reopen", `gh pr reopen 12 ${R}`],
    ["view", `gh pr view 12 ${R}`],
    ["--body-file on ready", `gh pr ready 12 ${R} --body-file x`],
    ["--body-file outside the project", `gh pr comment 12 ${R} --body-file /etc/passwd`],
    ["--body-file up and out", `gh pr comment 12 ${R} --body-file ../secret`],
    ["--body-file with .. inside", `gh pr comment 12 ${R} --body-file docs/../../secret`],
    [
      "--body-file of the sibling of the project",
      `gh pr comment 12 ${R} --body-file /work/proj2/x`,
    ],
    ["--body-file reading stdin", `gh pr comment 12 ${R} --body-file -`],
    ["a repeated --body-file", `gh pr comment 12 ${R} --body-file a --body-file b`],
    ["--body-file without a value", `gh pr comment 12 ${R} --body-file`],
    ["--body-file with a Windows path", `gh pr comment 12 ${R} --body-file C:\\Users\\x\\n.md`],
    ["-F", `gh pr comment 12 ${R} -F x`],
    ["--editor", `gh pr comment 12 ${R} --editor`],
    ["-e", `gh pr create ${R} --head fix -e`],
    ["--web", `gh pr create ${R} --head fix --web`],
    ["--admin", `gh pr ready 12 ${R} --admin`],
    ["--label", `gh pr create ${R} --head fix --label automerge`],
    ["--add-label", `gh pr edit 12 ${R} --add-label automerge`],
    ["--remove-label", `gh pr edit 12 ${R} --remove-label x`],
    ["an unknown option", `gh pr edit 12 ${R} --milestone 3`],
    ["an attached short value", `gh pr edit 12 ${R} -tTitle`],
    ["a value on a flag", `gh pr create ${R} --head fix --draft=false`],
    ["a missing value", `gh pr edit 12 ${R} --title`],
    ["gh api", "gh api repos/acme/app -X DELETE"],
    ["gh repo", "gh repo delete acme/app"],
    ["a gh path", `./gh pr ready 12 ${R}`],
    ["a different pr", `gh pr checkout 12 ${R}`],
    ["a substitution", "gh pr comment 12 -R acme/app --body \"$(cat <<'EOF'\nhi\nEOF\n)\""],
    ["a newline in a title", `gh pr edit 12 ${R} --title 'a\nb'`],
    ["a chained command", `gh pr ready 12 ${R} && gh pr merge 12 ${R}`],
  ])("refuses %s", async (_name, command) => {
    expect(await run(command)).toBeNull()
  })

  it("does not need the call's folder", async () => {
    expect(await allowed(`gh pr ready 12 ${R}`, undefined, null)).toBe(true)
  })

  it.each([
    `gh pr comment 12 ${R} --body-file note.md`,
    `gh pr comment 12 ${R} --body-file docs/note.md`,
    `gh pr comment 12 ${R} --body-file=./docs/note.md`,
    `gh pr comment 12 ${R} --body-file /work/proj/docs/note.md`,
    `gh pr comment 12 ${R} --body-file '/work/proj/a b.md'`,
    `gh pr create ${R} --head fix --title T --body-file body.md`,
    `gh pr edit 12 ${R} --body-file body.md`,
  ])("takes a body file inside the project: %s", async (command) => {
    expect(await allowed(command)).toBe(true)
  })

  it("resolves a body file against the call's folder, else the project root", async () => {
    const command = `gh pr comment 12 ${R} --body-file note.md`
    expect(await allowed(command, undefined, "/work/proj/sub")).toBe(true)
    expect(await allowed(command, undefined, null)).toBe(true)
    // An absolute path is judged where it is, whatever the folder.
    const absolute = `gh pr comment 12 ${R} --body-file /work/proj/sub/note.md`
    expect(await allowed(absolute, undefined, "/work/proj/other")).toBe(true)
    expect(
      await allowed(`gh pr comment 12 ${R} --body-file /work/elsewhere/n.md`, undefined, null),
    ).toBe(false)
  })

  it("needs the pr preset", async () => {
    expect(await allowed(`gh pr ready 12 ${R}`, [scope({ presets: ["push"] })])).toBe(false)
  })
})

describe("granted commands", () => {
  const commands = [
    { argv: ["uberepo", "ship"], rest: true },
    { argv: ["pwd"], rest: false },
    { argv: ["git", "status"], rest: false },
  ]
  const granted = scope({ presets: [], commands })

  it("match exact words and a rest command's plain words, saying which entry", async () => {
    expect(await run("pwd", [granted])).toEqual({ scope: 0, match: { kind: "command", index: 1 } })
    expect(await run("uberepo ship task/x --force-pr", [granted])).toEqual({
      scope: 0,
      match: { kind: "command", index: 0 },
    })
    expect(await run("git status", [granted])).toEqual({
      scope: 0,
      match: { kind: "command", index: 2 },
    })
  })

  it.each([
    ["more words than an exact command", "pwd -P"],
    ["a rest command without a word", "uberepo ship"],
    ["a path to the program", "/usr/bin/git status"],
    ["a variable prefix", "FOO=1 git status"],
    ["a chained command", "git status && curl x"],
    ["a quoted rest word", "uberepo ship 'a b'"],
    ["a rest substitution", "uberepo ship $(id)"],
    ["a rest redirect", "uberepo ship x > /etc/passwd"],
    ["git -C", "git -C / status"],
  ])("do not match %s", async (_name, command) => {
    expect(await run(command, [granted])).toBeNull()
  })

  it("never match a refused grant", async () => {
    const bad = scope({ presets: [], commands: [{ argv: ["python3"], rest: false }] })
    expect(await allowed("python3", [bad])).toBe(false)
  })

  it("do not match past 4096 characters of padding followed by another command", async () => {
    const padded = `pwd ${"a".repeat(5000)}; curl evil`
    expect(await allowed(padded, [granted])).toBe(false)
    expect(await allowed(`uberepo ship ${"a".repeat(5000)}; curl evil`, [granted])).toBe(false)
  })
})

describe("the call's folder", () => {
  const pwd = scope({ presets: [], commands: [{ argv: ["pwd"], rest: false }] })

  it("must be the project folder or inside it", async () => {
    expect(await allowed("pwd", [pwd], root)).toBe(true)
    expect(await allowed("pwd", [pwd], `${root}/a/b`)).toBe(true)
    expect(await allowed("pwd", [pwd], `${root}/a/../b`)).toBe(true)
    expect(await allowed("pwd", [pwd], "/work/other")).toBe(false)
    expect(await allowed("pwd", [pwd], "/work/proj2")).toBe(false)
    expect(await allowed("pwd", [pwd], `${root}/..`)).toBe(false)
    expect(await allowed("pwd", [pwd], `${root}/a/../../x`)).toBe(false)
    expect(await allowed("pwd", [pwd], "relative")).toBe(false)
    expect(await allowed("pwd", [pwd], "/")).toBe(false)
  })

  it("is unchecked where the harness does not tell it", async () => {
    expect(await allowed("pwd", [pwd], null)).toBe(true)
  })

  it("reads Windows paths in their own rules", async () => {
    const call = (cwd: string) => matchCall({ command: "pwd", cwd }, [pwd], git, "C:\\Work\\Proj")
    expect(await call("c:\\work\\proj\\sub")).not.toBeNull()
    expect(await call("C:\\Work\\Other")).toBeNull()
    expect(await call("C:\\Work\\Proj\\..\\Other")).toBeNull()
  })
})

describe("several scopes", () => {
  it("answer with the first scope that matches", async () => {
    const pr = scope({ presets: ["pr"] })
    const push = scope({ presets: ["push"] })
    expect(await run("git push origin fix:fix", [pr, push])).toEqual({
      scope: 1,
      match: { kind: "preset", preset: "push" },
    })
    expect(await run("git push origin fix:fix", [])).toBeNull()
  })
})

describe("real payload commands from the probes", () => {
  it("match nothing they should not", async () => {
    for (const command of ["touch /tmp/novadeck-e2e-8XYxTC/ran.txt", "cd sub", "gh pr ready 12\n"])
      // eslint-disable-next-line no-await-in-loop -- One command at a time.
      expect(await run(command)).toBeNull()
  })

  it("let a captured gh pr ready through once it names its repo", async () => {
    expect(await allowed("gh pr ready 12 -R acme/app")).toBe(true)
  })
})

describe("a Codex or Antigravity command on Windows", () => {
  const R = "-R acme/app"
  const windows = (command: string, scopes: readonly GrantScope[] = [scope()]) =>
    matchCall({ command, cwd: null, dialect: "windows-quote-free" }, scopes, git, "C:\\work\\proj")
  const pr = { scope: 0, match: { kind: "preset", preset: "pr" } }

  it.each([
    "gh pr create --fill --head x -R acme/app",
    "gh  pr   ready 12 -R acme/app",
    `gh pr comment 5 ${R} --body-file docs/note.md`,
    `gh pr comment 5 ${R} --body-file docs\\note.md`,
    `gh pr comment 5 ${R} --body-file C:\\work\\proj\\docs\\note.md`,
    `gh pr comment 5 ${R} --body-file C:/work/proj/docs/note.md`,
    `gh pr comment 5 ${R} --body-file c:\\WORK\\proj\\note.md`,
    `gh pr create ${R} --head fix --title T --body done`,
  ])("lets through %s", async (command) => {
    expect(await windows(command)).toEqual(pr)
  })

  it.each([
    ["a body file outside the project", `gh pr comment 5 ${R} --body-file C:\\work\\other\\n.md`],
    ["a body file on another drive", `gh pr comment 5 ${R} --body-file D:\\work\\proj\\n.md`],
    ["a body file with ..", `gh pr comment 5 ${R} --body-file docs\\..\\..\\n.md`],
    ["a body file with / ..", `gh pr comment 5 ${R} --body-file ../n.md`],
    ["a body file on a UNC path", `gh pr comment 5 ${R} --body-file \\\\host\\share\\n.md`],
    ["a drive-relative body file", `gh pr comment 5 ${R} --body-file D:n.md`],
    ["a single-quoted body", `gh pr comment 5 ${R} --body 'it is done'`],
    ["a double-quoted body", `gh pr comment 5 ${R} --body "done"`],
    ["a quoted word", `gh pr ready "12" ${R}`],
    ["a POSIX remote name for push", "git push origin fix:fix"],
  ])("refuses %s", async (_name, command) => {
    expect(await windows(command)).toBeNull()
  })

  it("refuses a body cmd would split at an ampersand, as Antigravity may run it there", async () => {
    // One safe word to the POSIX lexer, but cmd runs calc.
    const body = `gh pr create ${R} --head fix --title T --body 'x & calc & '`
    expect(await windows(body)).toBeNull()
    expect(await run(body)).not.toBeNull()
    expect(await windows(`gh pr create ${R} --head fix --title T --fill`)).toEqual(pr)
  })

  it("takes a push by URL like any other dialect", async () => {
    expect(await windows("git push https://github.com/acme/app fix:fix")).toEqual({
      scope: 0,
      match: { kind: "preset", preset: "push" },
    })
  })

  it("matches granted commands by their words", async () => {
    const commands = [
      { argv: ["ndmarker", "a.js"], rest: false },
      { argv: ["lint", "run"], rest: true },
    ]
    const only = [scope({ presets: [], commands })]
    expect(await windows("ndmarker a.js", only)).toEqual({
      scope: 0,
      match: { kind: "command", index: 0 },
    })
    expect(await windows("lint  run  src/a.ts --fix", only)).toEqual({
      scope: 0,
      match: { kind: "command", index: 1 },
    })
    expect(await windows("ndmarker 'a.js'", only)).toBeNull()
    expect(await windows("lint run %TEMP%", only)).toBeNull()
  })
})
