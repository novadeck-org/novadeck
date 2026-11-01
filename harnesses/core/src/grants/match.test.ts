import { beforeEach, describe, expect, it } from "vitest"

import type { FsLookups, GitLookups, GrantRepo, GrantScope, RolloutCall } from "../grants.js"
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
  // A tag is a tag in the working folder; a name in `broken` can't be told; any other is a branch.
  resolve: async (cwd, name) => {
    resolved.push(`${cwd} ${name}`)
    if (broken.has(name)) return undefined
    if (name in tags) return tags[name]
    return name === "HEAD" ? head.value : name.startsWith("new-") ? null : `refs/heads/${name}`
  },
  followsTags: async () => follows.value,
  recursesSubmodules: async () => recurses.value,
  pushTarget: async (_cwd, url) => rewrites.get(url) ?? [url],
}
const follows: { value: boolean | undefined } = { value: false }
const rewrites = new Map<string, readonly string[]>()
const recurses: { value: boolean | undefined } = { value: false }
const head = { value: "refs/heads/fix" as string | null }
const resolved: string[] = []
const broken = new Set<string>()
const tags: Record<string, string> = { "v1.0.0": "refs/tags/v1.0.0", "tags/v1": "refs/tags/v1" }

// The disk: every path is a regular file that is its own real path, unless a test says otherwise.
const codex = new Map<string, RolloutCall | undefined>()
const said = (command: string, workdir: string | null | undefined, planning = false) =>
  codex.set(command, { workdir, planning })
const links = new Map<string, { path: string; file: boolean } | undefined>()
const present = new Set<string>()
const fs: FsLookups = {
  real: async (path) => (links.has(path) ? links.get(path) : { path, file: true }),
  codexCall: async (_rollout, command) => codex.get(command),
  names: async (folder) =>
    [...present]
      .filter((path) => path.slice(0, path.search(/[\\/][^\\/]*$/)) === folder)
      .map((path) => path.slice(path.search(/[\\/][^\\/]*$/) + 1)),
}
beforeEach(() => {
  links.clear()
  present.clear()
  resolved.length = 0
  broken.clear()
  rewrites.clear()
  codex.clear()
  recurses.value = false
  follows.value = false
  head.value = "refs/heads/fix"
})

const run = (
  command: string,
  scopes: readonly GrantScope[] = [scope()],
  cwd: string | null = root,
) => matchCall({ command, cwd }, scopes, git, root, fs)

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

  it.each([
    ["a tag as the source", "git push origin v1.0.0:v9.9.9"],
    ["a tags/ source", "git push https://github.com/acme/app tags/v1:release-v2"],
    ["a branch name that is a local tag as the destination", "git push origin fix:v1.0.0"],
    ["a source that is no ref", "git push origin new-x:fix"],
    ["a source git can't resolve", "git push origin lost:fix"],
    ["a destination git can't resolve", "git push origin fix:lost"],
  ])("pushes branches only: refuses %s", async (_name, command) => {
    broken.add("lost")
    expect(await run(command)).toBeNull()
  })

  it("resolves the names in the call's folder, and takes HEAD and a new destination", async () => {
    expect(await allowed("git push origin fix:new-x")).toBe(true)
    expect(resolved).toEqual([`${root} fix`, `${root} new-x`])
    resolved.length = 0
    expect(await allowed("git push origin HEAD:new-x")).toBe(true)
    expect(resolved).toEqual([`${root} HEAD`, `${root} new-x`])
  })

  it("resolves in the call's folder, else the terminal's; never where the command may run elsewhere", async () => {
    const push = (call: object, terminal?: string) =>
      matchCall(
        { command: "git push https://github.com/acme/app fix:fix", cwd: null, ...call },
        [scope()],
        git,
        root,
        fs,
        terminal,
      )
    expect(await push({})).toBeNull()
    expect(await push({}, "/work/proj/sub")).not.toBeNull()
    expect(resolved[0]).toBe("/work/proj/sub fix")
    // Codex's `workdir` shows in neither hook: the session's or the terminal's folder is no answer.
    const hidden = { sessionFolder: "/work/proj/pkg", folderHidden: true }
    expect(await push(hidden, "/work/proj/sub")).toBeNull()
    expect(await push({ sessionFolder: "/work/proj/pkg" }, "/work/proj/sub")).not.toBeNull()
  })

  it("resolves HEAD like any source: one pointed at a tag, or at nothing, is no branch", async () => {
    expect(await allowed("git push origin HEAD:new-x")).toBe(true)
    for (const value of ["refs/tags/v1", "HEAD", null]) {
      head.value = value
      // eslint-disable-next-line no-await-in-loop -- One value at a time.
      expect(await allowed("git push origin HEAD:new-x"), String(value)).toBe(false)
    }
  })

  it("takes --no-follow-tags, and otherwise only where push.followTags is off", async () => {
    expect(await allowed("git push origin fix:new-x")).toBe(true)
    expect(await allowed("git push --no-follow-tags origin fix:new-x")).toBe(true)
    expect(await allowed("git push -u --no-follow-tags origin fix:new-x")).toBe(true)
    for (const value of [true, undefined]) {
      follows.value = value
      // eslint-disable-next-line no-await-in-loop -- One value at a time.
      expect(await allowed("git push origin fix:new-x"), String(value)).toBe(false)
      // eslint-disable-next-line no-await-in-loop -- As above.
      expect(await allowed("git push --no-follow-tags origin fix:new-x")).toBe(true)
    }
    expect(await allowed("git push --follow-tags origin fix:new-x")).toBe(false)
    expect(await allowed("git push --no-follow-tags --no-follow-tags origin fix:new-x")).toBe(false)
  })

  it("reads a URL as git rewrites it in the folder, and refuses one it can't", async () => {
    const url = "https://github.com/acme/app"
    rewrites.set(url, ["https://github.com/evil/app"])
    expect(await allowed(`git push ${url} fix:fix`)).toBe(false)
    // A form that is not a GitHub URL as typed is none, whatever it would be rewritten to.
    rewrites.set("gh:acme/app", [url])
    expect(await allowed("git push gh:acme/app fix:fix")).toBe(false)
    const unknown: GitLookups = { ...git, pushTarget: async () => undefined }
    expect(
      await matchCall(
        { command: `git push ${url} fix:fix`, cwd: root },
        [scope()],
        unknown,
        root,
        fs,
      ),
    ).toBeNull()
  })

  it("asks git in the folder Codex's rollout gives the call: its workdir, else the session's", async () => {
    const command = "git push https://github.com/acme/app fix:fix"
    const push = (rollout: boolean = true) =>
      matchCall(
        {
          command,
          cwd: null,
          sessionFolder: "/work/proj",
          folderHidden: true,
          ...(rollout && { rollout: { path: "/h/rollout-1.jsonl", turn: "t" } }),
        },
        [scope()],
        git,
        root,
        fs,
        "/work/proj/terminal",
      )
    // The rollout can't say, or the payload names none: no folder, no push.
    expect(await push()).toBeNull()
    expect(await push(false)).toBeNull()
    said(command, null)
    expect(await push()).not.toBeNull()
    expect(resolved[0]).toBe("/work/proj fix")
    said(command, "pkg/sub")
    resolved.length = 0
    expect(await push()).not.toBeNull()
    expect(resolved[0]).toBe("/work/proj/pkg/sub fix")
    expect(await push(false)).toBeNull()
    // Outside the project, or a rollout that fails, is no match.
    said(command, "/elsewhere")
    expect(await push()).toBeNull()
    said(command, "../other")
    expect(await push()).toBeNull()
  })

  it("holds Codex's workdir to the same-name check on Windows", async () => {
    const command = "gh pr ready 12 -R acme/app"
    const ready = () =>
      matchCall(
        {
          command,
          cwd: null,
          dialect: "windows-quote-free",
          sessionFolder: "C:\\work\\proj",
          folderHidden: true,
          rollout: { path: "C:\\h\\rollout-1.jsonl", turn: "t" },
        },
        [scope()],
        git,
        "C:\\work\\proj",
        fs,
      )
    said(command, "pkg")
    expect(await ready()).not.toBeNull()
    present.add("C:\\work\\proj\\pkg\\gh.js")
    expect(await ready()).toBeNull()
  })

  it("pushes on into submodules' own remotes only with them switched off", async () => {
    expect(await allowed("git push origin fix:new-x")).toBe(true)
    recurses.value = true
    expect(await allowed("git push origin fix:new-x")).toBe(false)
    expect(await allowed("git push --recurse-submodules=no origin fix:new-x")).toBe(true)
    expect(await allowed("git push --no-recurse-submodules origin fix:new-x")).toBe(true)
    recurses.value = undefined
    expect(await allowed("git push origin fix:new-x")).toBe(false)
    expect(await allowed("git push --recurse-submodules=no origin fix:new-x")).toBe(true)
    for (const flag of [
      "--recurse-submodules",
      "--recurse-submodules=on-demand",
      "--recurse-submodules=check",
    ])
      // eslint-disable-next-line no-await-in-loop -- One flag at a time.
      expect(await allowed(`git push ${flag} origin fix:new-x`), flag).toBe(false)
  })

  it("needs every place a URL pushes to to be the granted repo", async () => {
    const url = "https://github.com/acme/app"
    rewrites.set(url, [url, "https://github.com/evil/app"])
    expect(await allowed(`git push ${url} fix:fix`)).toBe(false)
    rewrites.set(url, [])
    expect(await allowed(`git push ${url} fix:fix`)).toBe(false)
    rewrites.set(url, [url, "git@github.com:acme/app.git"])
    expect(await allowed(`git push ${url} fix:fix`)).toBe(true)
  })

  it("takes nothing from a Codex turn that plans, or whose mode its rollout doesn't say", async () => {
    const command = "gh pr ready 12 -R acme/app"
    const call = (over: object = {}) =>
      matchCall(
        {
          command,
          cwd: null,
          sessionFolder: "/work/proj",
          folderHidden: true,
          rollout: { path: "/h/rollout-1.jsonl", turn: "t" },
          ...over,
        },
        [
          scope({
            commands: [{ argv: ["gh", "pr", "ready", "12", "-R", "acme/app"], rest: false }],
          }),
        ],
        git,
        root,
        fs,
      )
    said(command, undefined)
    expect(await call()).not.toBeNull()
    said(command, undefined, true)
    expect(await call()).toBeNull()
    codex.set(command, { workdir: undefined, planning: undefined })
    expect(await call()).toBeNull()
    codex.delete(command)
    expect(await call()).toBeNull()
    said(command, undefined)
    expect(await call({ rollout: undefined })).toBeNull()
  })

  it("refuses any push where no folder is known to ask git in, HEAD and a URL too", async () => {
    expect(await allowed("git push origin fix:fix", undefined, null)).toBe(false)
    expect(await allowed("git push https://github.com/acme/app HEAD:fix", undefined, null)).toBe(
      false,
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
    const fine = { ...git }
    const lookups: GitLookups[] = [
      { ...fine, pushUrls: async () => Promise.reject(new Error("no git")) },
      { ...fine, pushUrls: async () => undefined },
      { ...fine, pushUrls: async () => [] },
      {
        ...fine,
        pushUrls: () => {
          throw new Error("sync")
        },
      },
      { ...fine, pushUrls: () => new Promise(() => undefined) },
      // A ref that can't be told is no branch.
      { ...fine, resolve: async () => Promise.reject(new Error("no git")) },
      {
        ...fine,
        resolve: () => {
          throw new Error("sync")
        },
      },
      { ...fine, resolve: () => new Promise(() => undefined) },
      // Tags followed where that can't be told, or is on.
      { ...fine, followsTags: async () => undefined },
      { ...fine, recursesSubmodules: async () => undefined },
      { ...fine, recursesSubmodules: async () => true },
      { ...fine, followsTags: async () => true },
      { ...fine, followsTags: () => new Promise(() => undefined) },
    ]
    for (const lookup of lookups)
      expect(
        // eslint-disable-next-line no-await-in-loop -- One lookup at a time.
        await matchCall(
          { command: "git push origin fix:fix", cwd: root },
          [scope()],
          lookup,
          root,
          fs,
        ),
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

  it("resolves a body file against the call's folder, and takes only an absolute one where it is unknown", async () => {
    const command = `gh pr comment 12 ${R} --body-file note.md`
    expect(await allowed(command, undefined, "/work/proj/sub")).toBe(true)
    // Codex's and Antigravity's folder isn't known: a relative path might lie anywhere.
    expect(await allowed(command, undefined, null)).toBe(false)
    expect(
      await allowed(`gh pr comment 12 ${R} --body-file /work/proj/note.md`, undefined, null),
    ).toBe(true)
    expect(await allowed(`gh pr comment 12 ${R} --body-file sub/note.md`, undefined, null)).toBe(
      false,
    )
    expect(await allowed(`gh pr comment 12 ${R} --body-file ./note.md`, undefined, null)).toBe(
      false,
    )
    // An absolute path is judged where it is, whatever the folder.
    const absolute = `gh pr comment 12 ${R} --body-file /work/proj/sub/note.md`
    expect(await allowed(absolute, undefined, "/work/proj/other")).toBe(true)
    expect(
      await allowed(`gh pr comment 12 ${R} --body-file /work/elsewhere/n.md`, undefined, null),
    ).toBe(false)
  })

  it("refuses a body file that is a symlink out of the project, a directory, or unreadable", async () => {
    const command = `gh pr comment 12 ${R} --body-file /work/proj/note.md`
    expect(await allowed(command)).toBe(true)
    links.set("/work/proj/note.md", { path: "/etc/passwd", file: true })
    expect(await allowed(command)).toBe(false)
    links.set("/work/proj/note.md", { path: "/work/proj/real.md", file: true })
    expect(await allowed(command)).toBe(true)
    links.set("/work/proj/note.md", { path: "/work/proj/dir", file: false })
    expect(await allowed(command)).toBe(false)
    links.set("/work/proj/note.md", undefined)
    expect(await allowed(command)).toBe(false)
  })

  it("compares real paths, so a root that is itself a link still holds its files", async () => {
    links.set("/work/proj", { path: "/data/proj", file: false })
    links.set("/work/proj/note.md", { path: "/data/proj/note.md", file: true })
    expect(await allowed(`gh pr comment 12 ${R} --body-file /work/proj/note.md`)).toBe(true)
    links.set("/work/proj/note.md", { path: "/work/proj/note.md", file: true })
    expect(await allowed(`gh pr comment 12 ${R} --body-file /work/proj/note.md`)).toBe(false)
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
    const call = (cwd: string) =>
      matchCall({ command: "pwd", cwd }, [pwd], git, "C:\\Work\\Proj", fs)
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
    matchCall(
      { command, cwd: null, dialect: "windows-quote-free" },
      scopes,
      git,
      "C:\\work\\proj",
      fs,
    )
  const pr = { scope: 0, match: { kind: "preset", preset: "pr" } }

  it.each([
    "gh pr create --fill --head x -R acme/app",
    "gh  pr   ready 12 -R acme/app",
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
    [
      "a relative body file, as its folder is unknown",
      `gh pr comment 5 ${R} --body-file docs/n.md`,
    ],
    ["a backslash relative body file", `gh pr comment 5 ${R} --body-file docs\\n.md`],
    ["a dot-relative body file", `gh pr comment 5 ${R} --body-file .\\n.md`],
    ["a rooted body file with no drive", `gh pr comment 5 ${R} --body-file \\work\\proj\\n.md`],
    ["a slash-rooted body file with no drive", `gh pr comment 5 ${R} --body-file /work/proj/n.md`],
    ["a \\\\?\\ body file", `gh pr comment 5 ${R} --body-file \\\\?\\C:\\work\\proj\\n.md`],
    ["a \\\\.\\ body file", `gh pr comment 5 ${R} --body-file \\\\.\\C:\\work\\proj\\n.md`],
    [
      "a drive-relative body file in the project's drive",
      `gh pr comment 5 ${R} --body-file C:n.md`,
    ],
    ["a stream of a file", `gh pr comment 5 ${R} --body-file C:\\work\\proj\\n.md:x`],
    ["a body file with ..", `gh pr comment 5 ${R} --body-file docs\\..\\..\\n.md`],
    ["a body file with / ..", `gh pr comment 5 ${R} --body-file ../n.md`],
    ["a body file on a UNC path", `gh pr comment 5 ${R} --body-file \\\\host\\share\\n.md`],
    ["a drive-relative body file", `gh pr comment 5 ${R} --body-file D:n.md`],
    ["a single-quoted body", `gh pr comment 5 ${R} --body 'it is done'`],
    ["a double-quoted body with a dollar sign", `gh pr comment 5 ${R} --body "$done"`],
    [
      "a quoted body file ending in a backslash",
      `gh pr comment 5 ${R} --body-file "C:\\work\\proj\\"`,
    ],
    [
      "a quoted body file outside the project",
      `gh pr comment 5 ${R} --body-file "C:\\work\\other dir\\n.md"`,
    ],
    ["a POSIX remote name for push", "git push origin fix:fix"],
  ])("refuses %s", async (_name, command) => {
    expect(await windows(command)).toBeNull()
  })

  it("takes a spaced absolute body file and a spaced title in double quotes, inside a project whose path has a space", async () => {
    const spaced = (command: string) =>
      matchCall(
        { command, cwd: null, dialect: "windows-quote-free" },
        [scope()],
        git,
        "C:\\Users\\Jan Kowalski\\proj",
        fs,
      )
    expect(
      await spaced(
        `gh pr comment 5 ${R} --body-file "C:\\Users\\Jan Kowalski\\proj\\my notes\\n.md"`,
      ),
    ).toEqual(pr)
    expect(
      await spaced(
        `gh pr create ${R} --head fix --title "Fix the bug" --body-file "C:/Users/Jan Kowalski/proj/n.md"`,
      ),
    ).toEqual(pr)
    expect(
      await spaced(`gh pr comment 5 ${R} --body-file "C:\\Users\\Jan Kowalski\\other\\n.md"`),
    ).toBeNull()
  })

  it.each(["CON", "con", "NUL", "nul.txt", "Aux.md", "PRN", "COM1", "lpt9.x.y", "COM9.txt"])(
    "refuses the device name %s in any segment of a body file",
    async (name) => {
      for (const path of [
        `C:\\work\\proj\\${name}`,
        `C:\\work\\proj\\docs\\${name}`,
        `C:\\work\\proj\\${name}\\n.md`,
        `C:/work/proj/${name}`,
      ])
        // eslint-disable-next-line no-await-in-loop -- One path at a time.
        expect(await windows(`gh pr comment 5 ${R} --body-file ${path}`)).toBeNull()
    },
  )

  it.each([".exe", ".com", ".bat", ".cmd", ".ps1", ".EXE"])(
    "refuses a program that the project root holds as gh%s, which cmd runs first",
    async (suffix) => {
      expect(await windows("gh pr ready 12 -R acme/app")).toEqual(pr)
      present.add(`C:\\work\\proj\\gh${suffix}`)
      // Windows' names don't care for case.
      if (suffix === ".EXE") present.add("C:\\work\\proj\\gh.exe")
      expect(await windows("gh pr ready 12 -R acme/app")).toBeNull()
    },
  )

  it("refuses a granted command and a push too when the root holds the program, and when it can't tell", async () => {
    const only = [scope({ presets: [], commands: [{ argv: ["ndmarker"], rest: false }] })]
    expect(await windows("ndmarker", only)).not.toBeNull()
    present.add("C:\\work\\proj\\ndmarker.cmd")
    expect(await windows("ndmarker", only)).toBeNull()
    present.clear()
    const unknown: FsLookups = { ...fs, names: async () => undefined }
    expect(
      await matchCall(
        { command: "ndmarker", cwd: null, dialect: "windows-quote-free" },
        only,
        git,
        "C:\\work\\proj",
        unknown,
      ),
    ).toBeNull()
  })

  it.each(["gh.js", "gh.vbs", "gh.wsf", "gh.py", "gh", "GH.JSE", "gh.anything.else"])(
    "refuses a program that the project root holds as %s, whatever its extension",
    async (name) => {
      present.add(`C:\\work\\proj\\${name}`)
      expect(await windows("gh pr ready 12 -R acme/app")).toBeNull()
    },
  )

  it("takes names that only start like the program", async () => {
    present.add("C:\\work\\proj\\ghost.exe")
    present.add("C:\\work\\proj\\gh-pages")
    expect(await windows("gh pr ready 12 -R acme/app")).toEqual(pr)
  })

  it("holds the session's folder and the terminal's to the same check", async () => {
    const ready = (call: { sessionFolder?: string }, terminal?: string) =>
      matchCall(
        {
          command: "gh pr ready 12 -R acme/app",
          cwd: null,
          dialect: "windows-quote-free",
          ...call,
        },
        [scope()],
        git,
        "C:\\work\\proj",
        fs,
        terminal,
      )
    const session = "C:\\work\\proj\\pkg"
    const terminal = "C:\\work\\proj\\sub"
    expect(await ready({ sessionFolder: session }, terminal)).not.toBeNull()
    present.add(`${session}\\gh.js`)
    expect(await ready({ sessionFolder: session }, terminal)).toBeNull()
    expect(await ready({}, terminal)).not.toBeNull()
    present.clear()
    present.add(`${terminal}\\gh.cmd`)
    expect(await ready({ sessionFolder: session }, terminal)).toBeNull()
    expect(await ready({ sessionFolder: session })).not.toBeNull()
  })

  it("leaves POSIX calls alone when the root holds the program", async () => {
    present.add("/work/proj/gh.exe")
    expect(await allowed("gh pr ready 12 -R acme/app")).toBe(true)
  })

  describe("Claude Code's Git Bash", () => {
    // A POSIX dialect over a Windows project: Claude Code's Bash tool on Windows.
    const bash = (path: string, cwd: string | null = "C:\\work\\proj") =>
      matchCall(
        { command: `gh pr comment 5 ${R} --body-file ${path}`, cwd },
        [scope()],
        git,
        "C:\\work\\proj",
        fs,
      )

    it.each([
      "/work/proj/n.md",
      "/tmp/n.md",
      "//work/proj/n.md",
      "/c/work/proj/n.md",
      "a:/b",
      "docs:/n.md",
      "x:y/n.md",
    ])("refuses %s, which MSYS rewrites to another file", async (path) => {
      expect(await bash(path)).toBeNull()
      // The value after an equals sign is converted too.
      expect(
        await matchCall(
          { command: `gh pr comment 5 ${R} --body-file=${path}`, cwd: "C:\\work\\proj" },
          [scope()],
          git,
          "C:\\work\\proj",
          fs,
        ),
      ).toBeNull()
    })

    it.each(["n.md", "docs/n.md", "./n.md", "C:/work/proj/n.md"])("takes %s", async (path) => {
      expect(await bash(path)).toEqual(pr)
    })

    it("leaves a POSIX project, and Codex's and Antigravity's own dialect, alone", async () => {
      expect(await allowed(`gh pr comment 12 ${R} --body-file /work/proj/note.md`)).toBe(true)
      expect(
        await windows(`gh pr comment 5 ${R} --body-file C:\\work\\proj\\docs\\note.md`),
      ).toEqual(pr)
    })
  })

  it("takes names that only look like devices", async () => {
    for (const name of ["console.md", "COM10", "COM0", "lpt.md", "nulls.txt", "comm1"])
      // eslint-disable-next-line no-await-in-loop -- One path at a time.
      expect(await windows(`gh pr comment 5 ${R} --body-file C:\\work\\proj\\${name}`)).toEqual(pr)
  })

  it("refuses a body cmd would split at an ampersand, as Antigravity may run it there", async () => {
    // One safe word to the POSIX lexer, but cmd runs calc.
    const body = `gh pr create ${R} --head fix --title T --body 'x & calc & '`
    expect(await windows(body)).toBeNull()
    expect(await run(body)).not.toBeNull()
    expect(await windows(`gh pr create ${R} --head fix --title T --fill`)).toEqual(pr)
  })

  it("takes a push by URL like any other dialect, asking git in the terminal's folder", async () => {
    const push = (call: object) =>
      matchCall(
        {
          command: "git push https://github.com/acme/app HEAD:fix",
          cwd: null,
          dialect: "windows-quote-free",
          ...call,
        },
        [scope()],
        git,
        "C:\\work\\proj",
        fs,
        "C:\\work\\proj",
      )
    expect(await push({})).toEqual({ scope: 0, match: { kind: "preset", preset: "push" } })
    // Codex's command may run in a `workdir` no hook shows.
    expect(await push({ folderHidden: true, sessionFolder: "C:\\work\\proj" })).toBeNull()
    expect(await windows("git push https://github.com/acme/app HEAD:fix")).toBeNull()
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
