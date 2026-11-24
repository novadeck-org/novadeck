/* eslint-disable no-await-in-loop -- Each case reads one command. */
import { describe, expect, it } from "vitest"

import { readCommand, type Lookups } from "./reader.js"

// A repository `r/app` whose checkout at /w is on `feat/x` (the agent's own), and /main on main.
const lookups: Lookups = {
  branch: async (cwd) => (cwd === "/main" ? "main" : cwd === "/w" ? "feat/x" : undefined),
  upstream: async (_cwd, branch) =>
    branch === "main" ? { remote: "origin", branch: "main" } : undefined,
  repo: async () => "r/app",
  ghRepo: async () => "r/app",
  remoteRepo: async () => "r/app",
  tag: async () => false,
  own: async (_cwd, branch) => branch === "feat/x",
}
const read = (command: string, cwd = "/w") => readCommand(command, cwd, lookups)
const keys = async (command: string, cwd?: string) => {
  const reading = await read(command, cwd)
  return reading.kind === "none"
    ? "none"
    : (reading.refusal ?? reading.actions.map((each) => each.key))
}

describe("what a command ships", () => {
  it("leaves commands that ship nothing alone", async () => {
    for (const command of [
      "git status",
      "git commit -m 'merge it'",
      "git merge-base main HEAD",
      "git mergetool",
      "echo git push origin main",
      "gh pr view 12",
      "gh pr list",
      "gh api repos/r/app/pulls",
      "git push origin feat/x",
      "git push -f origin HEAD",
      "git merge main",
      "ls | cat",
    ])
      expect(await keys(command), command).toBe("none")
  })

  it("reads a push by its target, resolved from git", async () => {
    expect(await keys("git push origin main", "/w")).toEqual(["push:r/app:origin/main"])
    expect(await keys("git push", "/main")).toEqual(["push:r/app:origin/main"])
    expect(await keys("git push origin HEAD:main")).toEqual(["push:r/app:origin/main"])
    expect(await keys("git -C /main push origin main;")).toEqual(["push:r/app:origin/main"])
  })

  it("reads a force push as its own single-use action", async () => {
    const reading = await read("git push --force origin main")
    expect(reading).toMatchObject({
      kind: "ships",
      actions: [{ kind: "push-force", key: "push-force:r/app:origin/main", singleUse: true }],
    })
    expect(await keys("git push origin +main")).toEqual(["push-force:r/app:origin/main"])
  })

  it("reads a landing as the branch checked out where it runs", async () => {
    expect(await keys("git merge feat/x", "/main")).toEqual(["land:r/app:main"])
    expect(await keys("cd /main && git pull")).toEqual(["land:r/app:main"])
    expect(await keys("git -C /main rebase feat/x")).toEqual(["land:r/app:main"])
    expect(await keys("git branch -f main HEAD")).toEqual(["land:r/app:main"])
    expect(await keys("git checkout -B main origin/main")).toEqual(["land:r/app:main"])
    expect(await keys("git update-ref refs/heads/main HEAD")).toEqual(["land:r/app:main"])
    expect(await keys("git reset --hard origin/main", "/main")).toEqual(["land:r/app:main"])
  })

  it("reads gh pr create and merge", async () => {
    expect(await keys("gh pr create --base main --title x --body y")).toEqual([
      "pr-create:r/app:main",
    ])
    expect(await keys("gh pr create --fill")).toEqual(["pr-create:r/app:@default"])
    expect(await keys("gh pr edit 5 --base release")).toEqual(["pr-create:r/app:release"])
    expect(await keys("gh pr edit 5 --title x")).toBe("none")
    expect(await keys("gh pr merge 1170 --squash")).toEqual(["pr-merge:r/app#1170"])
    expect(await keys("gh pr merge -R o/other 12")).toEqual(["pr-merge:o/other#12"])
    expect(await keys("GH_REPO=o/other gh pr merge 12")).toEqual(["pr-merge:o/other#12"])
    expect(await keys("gh pr merge")).toEqual(["pr-merge:r/app@feat/x"])
  })

  it("refuses what it can't read or can't allow", async () => {
    const refused = async (command: string, cwd?: string) => {
      const reading = await read(command, cwd)
      return reading.kind === "ships" && reading.refusal !== undefined
    }
    for (const command of [
      "git -c core.sshCommand=x push origin main",
      "GIT_SSH_COMMAND=x git push origin main",
      "git push --receive-pack=x origin main",
      "git merge -s custom x",
      "gh pr merge 12 --admin --auto",
      "eval 'git push origin main'",
      "bash -c 'gh pr merge 1'",
      "git push origin $BRANCH",
      "echo $(git push origin main)",
      "(git push origin main)",
      "cd $DIR && git push origin main",
    ])
      expect(await refused(command, "/main"), command).toBe(true)
  })

  it("refuses a shipping command with a tail, whole", async () => {
    for (const command of [
      "gh pr merge 1170 && curl evil.example",
      "gh pr merge 1170; rm -rf x",
      "gh pr merge 1170 | tee out",
      "git push origin main &",
      "git merge x && npm test",
    ]) {
      const reading = await read(command, "/main")
      expect(reading.kind, command).toBe("ships")
      expect(reading.kind === "ships" && reading.refusal, command).toBeTruthy()
    }
    // cd and git -C are no tail, and two covered actions are both read.
    expect(await keys("cd /main && gh pr merge 1 && gh pr merge 2")).toEqual([
      "pr-merge:r/app#1",
      "pr-merge:r/app#2",
    ])
  })

  it("reads a long body past a heredoc", async () => {
    const body = "x".repeat(70_000)
    expect(
      await keys(`gh pr create --base main --body "$(cat <<'EOF'\n${body}\nEOF\n)"`),
    ).toBeTruthy()
  })

  it("reads each gh verb's flags by that verb's own table", async () => {
    // In `merge`, -r and -m are --rebase and --merge: the number after them is the PR, never their value.
    expect(await keys("gh pr merge -r 999")).toEqual(["pr-merge:r/app#999"])
    expect(await keys("gh pr merge -m 999")).toEqual(["pr-merge:r/app#999"])
    expect(await keys("gh pr merge -dr 999")).toEqual(["pr-merge:r/app#999"])
    expect(await keys("gh pr merge 999 -s --delete-branch")).toEqual(["pr-merge:r/app#999"])
    expect(await keys("gh pr merge -r")).toEqual(["pr-merge:r/app@feat/x"])
    // ... while in `create` they take a value.
    expect(await keys("gh pr create -r someone -m 1.0 --fill")).toEqual([
      "pr-create:r/app:@default",
    ])
    // Attached values.
    expect(await keys("gh pr merge 12 -Rother/repo")).toEqual(["pr-merge:other/repo#12"])
    expect(await keys("gh pr merge 12 --squash -Rother/repo")).toEqual(["pr-merge:other/repo#12"])
    expect(await keys("gh pr merge 12 --repo=other/repo")).toEqual(["pr-merge:other/repo#12"])
    expect(await keys("gh pr -R other/repo merge 12")).toEqual(["pr-merge:other/repo#12"])
    expect(await keys("gh pr create -Bmain")).toEqual(["pr-create:r/app:main"])
    expect(await keys("gh pr create -Rother/repo --base main")).toEqual([
      "pr-create:other/repo:main",
    ])
    expect(await keys("gh pr create --base=release")).toEqual(["pr-create:r/app:release"])
    expect(await keys("gh pr edit 5 -Brelease")).toEqual(["pr-create:r/app:release"])
  })

  it("takes the repository of a PR's URL, and refuses one that isn't the command's", async () => {
    expect(await keys("gh pr merge https://github.com/r/app/pull/12")).toEqual([
      "pr-merge:r/app#12",
    ])
    expect(await keys("gh pr merge https://github.com/other/repo/pull/12 -R other/repo")).toEqual([
      "pr-merge:other/repo#12",
    ])
    // With no repository of its own naming, the URL's is the one gh acts on.
    expect(await keys("gh pr merge https://github.com/other/repo/pull/12")).toEqual([
      "pr-merge:other/repo#12",
    ])
    expect(await keys("gh pr merge https://github.com/other/repo/pull/12 -R r/app")).toMatch(
      /names other\/repo/,
    )
  })

  it("refuses a flag it doesn't know for the verb", async () => {
    for (const command of [
      "gh pr merge 12 --bogus",
      "gh pr merge 12 -x",
      "gh pr create --fill --bogus=1",
      "gh pr create -Z",
      "gh pr edit 5 --base main --whatever",
      "gh pr merge 12 -R",
    ]) {
      const reading = await read(command)
      expect(reading.kind === "ships" && reading.refusal, command).toBeTruthy()
    }
  })

  it("voids a PR's merge permits when its base is edited", async () => {
    expect(await read("gh pr edit 5 --base release")).toMatchObject({
      actions: [{ key: "pr-create:r/app:release", voids: ["pr-merge:r/app#5"] }],
    })
    expect(await read("gh pr edit --base release")).toMatchObject({
      actions: [{ voids: ["pr-merge:r/app@feat/x"] }],
    })
    expect(await read("gh pr edit https://github.com/r/app/pull/7 -B x")).toMatchObject({
      actions: [{ voids: ["pr-merge:r/app#7"] }],
    })
  })

  it("reads update-ref's message as no ref", async () => {
    expect(await keys("git update-ref -m refs/heads/feat/x refs/heads/main HEAD")).toEqual([
      "land:r/app:main",
    ])
    expect(await keys("git update-ref -m 'move it' refs/heads/main HEAD")).toEqual([
      "land:r/app:main",
    ])
    expect(await keys("git update-ref -m msg refs/heads/feat/x HEAD")).toBe("none")
    // Options it doesn't model are left alone.
    expect(await keys("git update-ref --stdin")).toBe("none")
  })

  it("refuses an allowed command that redirects into a file", async () => {
    expect(await keys("git push origin main > ~/.bashrc")).toMatch(/redirects/)
    expect(await keys("git push origin main >> notes.txt")).toMatch(/redirects/)
    expect(await keys("git push origin main 2> err.log")).toMatch(/redirects/)
    expect(await keys("git push origin main &> out")).toBeTruthy()
    expect(await keys("cd /main > ~/.bashrc && gh pr merge 1")).toMatch(/redirects/)
    expect(await keys("gh pr merge 5 > /dev/tty")).toMatch(/redirects/)
    for (const tail of ["2>&1", ">/dev/null", "2>/dev/null", "> /dev/null 2>&1"])
      expect(await keys(`git push origin main ${tail}`), tail).toEqual(["push:r/app:origin/main"])
    expect(await keys("gh pr create --body-file - <<'EOF'\nbody\nEOF")).toEqual([
      "pr-create:r/app:@default",
    ])
  })

  it("reads these ref moves as landings, wherever the flags stand", async () => {
    const at = (command: string) => keys(command, "/main")
    const main = ["land:r/app:main"]
    for (const command of [
      "git branch -M feat/x main",
      "git branch -m feat/x main",
      "git branch -m main",
      "git branch -c feat/x main",
      "git branch -f main HEAD",
      "git branch main HEAD -f",
      "git branch -fq main HEAD",
      "git branch --force main HEAD",
      "git merge --no-commit x",
      "git reset HEAD~1",
      "git reset --mixed HEAD~1",
      "git reset --soft HEAD~1",
      "git fetch . x:main",
      "git fetch --update-head-ok . +x:refs/heads/main",
      "git pull origin a:main",
      "git rebase main main",
      "git rebase --onto a b main",
      "git checkout -fB main",
      "git checkout -B main",
      "git checkout -Bmain origin/main",
      "git switch -C main",
      "git switch --force-create main",
    ])
      expect(await at(command), command).toEqual(main)
    // The branch a rebase names, not the one it is run on, is what it moves.
    expect(await keys("git rebase main release", "/w")).toEqual(["land:r/app:release"])
    // A branch moved to a name is moved away too, and a pull writes the refspec's branch as well.
    expect(await keys("git branch -m feat/x other", "/w")).toEqual(["land:r/app:other"])
    expect(await at("git branch -m main old")).toEqual(["land:r/app:main", "land:r/app:old"])
    expect(await keys("git pull origin a:b", "/w")).toEqual(["land:r/app:b"])
    expect(await at("git pull origin a:b")).toEqual(["land:r/app:b", "land:r/app:main"])
  })

  it("leaves these alone: they move nothing of anyone's", async () => {
    for (const command of [
      "git reset",
      "git reset -- file.txt",
      "git reset --hard HEAD~1",
      "git fetch origin",
      "git fetch origin x:refs/remotes/origin/x",
      "git fetch origin x:feat/x",
      "git branch -d old",
      "git branch --list",
      "git branch -f feat/x HEAD",
      "git checkout -b new",
      "git checkout main",
      "git merge --abort",
      "git rebase --continue",
    ])
      expect(await keys(command, "/w"), command).toBe("none")
  })

  it("refuses a command that goes by the branch checked out after one in it switched", async () => {
    const why = "it switches branch first, so Novadeck can't tell where this lands"
    for (const command of [
      "git checkout main && git merge feat/x",
      "git switch main && git pull",
      "git checkout main; git rebase feat/x",
      "git checkout main && git reset --hard origin/main",
      "git switch main && git cherry-pick abc",
      "git checkout main && git push",
      "git checkout main && git push origin main",
      "git checkout -b other && git merge feat/x",
    ])
      expect(await keys(command, "/w"), command).toMatch(why)
    // Run on their own, each is read as usual; a switch alone, and a command naming its refs, are fine.
    expect(await keys("git merge feat/x", "/main")).toEqual(["land:r/app:main"])
    expect(await keys("git checkout main && git status", "/w")).toBe("none")
    // A folder named rather than switched to is read as ever.
    expect(await keys("cd /main && git merge feat/x", "/w")).toEqual(["land:r/app:main"])
    // The single-command forms that move a branch while switching are read by what they move.
    expect(await keys("git checkout -B main origin/main", "/w")).toEqual(["land:r/app:main"])
    expect(await keys("git switch -C main origin/main", "/w")).toEqual(["land:r/app:main"])
    expect(await keys("git pull origin a:main", "/w")).toEqual(["land:r/app:main"])
  })

  it("refuses what it can't read of these", async () => {
    for (const command of ["git rebase -x 'make' main", "git rebase --exec=make main"]) {
      const reading = await read(command, "/main")
      expect(reading.kind === "ships" && reading.refusal, command).toBeTruthy()
    }
    expect(await keys("gh api -X GET repos/r/app/pulls", "/main")).toBe("none")
    expect(await keys("gh api --method=get repos/r/app/pulls", "/main")).toBe("none")
  })

  it("names the remote --repo gives a push", async () => {
    expect(await keys("git push --repo upstream main", "/main")).toEqual([
      "push:r/app:upstream/main",
    ])
    expect(await keys("git push --repo=upstream main", "/main")).toEqual([
      "push:r/app:upstream/main",
    ])
  })

  it("leaves alone what the gate doesn't model", async () => {
    for (const command of [
      "git push --mirror",
      "git push --all",
      "git push --tags",
      "git push --tags origin",
      "git push origin :main",
      "git push origin --delete main",
      "git push -d origin main",
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push origin refs/tags/v1",
      "git push origin v1:refs/tags/v1",
      "git fetch . 'refs/heads/*:refs/heads/*'",
      "git fetch . x:refs/tags/v1",
      "gh release create v1.0 --notes x",
      "gh api -XPOST repos/r/app/merges",
      "gh api --method DELETE repos/r/app",
      "gh api repos/r/app -f title=x",
      "gh pr edit 5 --whatever",
      "gh pr merge 12 --disable-auto",
      "gh pr merge --disable-auto -R other/repo 12",
    ])
      expect(await keys(command, "/main"), command).toBe("none")
  })

  it("denies an unmodelled part that comes with a guarded target, with how to split it", async () => {
    for (const command of [
      "git push --tags origin HEAD:release",
      "git push origin main 'refs/heads/*:refs/heads/*'",
      "git push origin main :old",
      "git push --follow-tags",
      "git push --no-such-flag origin main",
    ]) {
      const reading = await read(command, "/main")
      expect(reading, command).toMatchObject({ kind: "ships", actions: [] })
      expect(reading.kind === "ships" && reading.refusal, command).toBeTruthy()
      expect(reading.kind === "ships" && reading.remedy, command).toMatch(/separate|without/)
    }
    expect(await read("git push --tags origin HEAD:release", "/main")).toMatchObject({
      remedy: "Push the branch and the tags separately.",
    })
  })

  it("reads a bare tag name as a tag", async () => {
    const tagged: Lookups = { ...lookups, tag: async (_cwd, name) => name === "v1.0" }
    expect(await readCommand("git push origin v1.0", "/main", tagged)).toEqual({ kind: "none" })
    expect(await keys("git push origin v2.0", "/main")).toEqual(["push:r/app:origin/v2.0"])
  })

  it("gives --auto and --admin targets of their own, by number and by branch", async () => {
    expect(await keys("gh pr merge 12 --auto --squash")).toEqual(["pr-auto:r/app#12"])
    expect(await keys("gh pr merge --auto")).toEqual(["pr-auto:r/app@feat/x"])
    expect(await keys("gh pr merge some-branch --auto")).toEqual(["pr-auto:r/app@some-branch"])
    expect(await read("gh pr merge 12 --admin")).toMatchObject({
      actions: [{ kind: "pr-admin", key: "pr-admin:r/app#12", singleUse: true }],
    })
    expect(await keys("gh pr merge --admin")).toEqual(["pr-admin:r/app@feat/x"])
    expect(await keys("gh pr merge 12 --admin --auto")).toMatch(/refuses/)
  })

  it("pushes to the repository of the remote it names, not gh's", async () => {
    const forked: Lookups = {
      ...lookups,
      ghRepo: async () => "up/app",
      remoteRepo: async (_cwd, remote) => (remote === "origin" ? "me/app" : "up/app"),
    }
    const keyOf = async (command: string) => {
      const reading = await readCommand(command, "/main", forked)
      return reading.kind === "ships" ? reading.actions.map((each) => each.key) : reading
    }
    expect(await keyOf("git push origin HEAD:release")).toEqual(["push:me/app:origin/release"])
    expect(await keyOf("git push upstream HEAD:release")).toEqual(["push:up/app:upstream/release"])
    // ... while gh acts on its own: the upstream here.
    expect(await keyOf("gh pr merge 3")).toEqual(["pr-merge:up/app#3"])
    expect(await keyOf("gh pr merge 3 -R me/app")).toEqual(["pr-merge:me/app#3"])
    expect(await keyOf("GH_REPO=me/app gh pr create --base main")).toEqual([
      "pr-create:me/app:main",
    ])
  })

  it("denies a gh pr command whose repository it can't tell, naming -R", async () => {
    const unknown: Lookups = { ...lookups, ghRepo: async () => undefined }
    for (const command of ["gh pr merge 3", "gh pr create --base main", "gh pr merge 3 --auto"]) {
      const reading = await readCommand(command, "/main", unknown)
      expect(reading, command).toMatchObject({
        kind: "ships",
        remedy: "Name the repository with -R owner/repo.",
      })
    }
    // A PR's URL or -R names it.
    expect(await readCommand("gh pr merge 3 -R a/b", "/main", unknown)).toMatchObject({
      actions: [{ key: "pr-merge:a/b#3" }],
    })
    expect(
      await readCommand("gh pr merge https://github.com/a/b/pull/3", "/main", unknown),
    ).toMatchObject({ actions: [{ key: "pr-merge:a/b#3" }] })
  })

  it("denies an unknown option of branch or update-ref that comes with a guarded branch", async () => {
    for (const command of [
      "git branch -f -v main HEAD~1",
      "git branch -f --no-color main HEAD~1",
      "git branch --force --verbose main HEAD~1",
      "git update-ref -d refs/heads/main",
    ]) {
      const reading = await read(command, "/main")
      expect(reading, command).toMatchObject({ kind: "ships", actions: [] })
      expect(reading.kind === "ships" && reading.refusal, command).toMatch(/doesn't know/)
      expect(reading.kind === "ships" && reading.remedy, command).toMatch(/without it/)
    }
    // Nothing guarded, or nothing modelled: left alone.
    expect(await keys("git branch -f -v feat/x HEAD~1", "/main")).toBe("none")
    expect(await keys("git update-ref --stdin", "/main")).toBe("none")
    expect(await keys("git update-ref -d refs/tags/v1", "/main")).toBe("none")
  })

  it("keys a repository by its lower case, whatever way it was written", async () => {
    const mixed: Lookups = { ...lookups, ghRepo: async () => "Mzpk/Novadeck" }
    const key = async (command: string) => {
      const reading = await readCommand(command, "/main", mixed)
      return reading.kind === "ships" ? reading.actions.map((each) => each.key) : reading
    }
    expect(await key("gh pr merge 3")).toEqual(["pr-merge:mzpk/novadeck#3"])
    expect(await key("gh pr merge 3 -R mzpk/NOVADECK")).toEqual(["pr-merge:mzpk/novadeck#3"])
  })
})

describe("a command written for PowerShell", () => {
  const ps = (command: string, cwd = "/w") => readCommand(command, cwd, lookups, "powershell")
  const shipped = async (command: string, cwd?: string) => {
    const reading = await ps(command, cwd)
    return reading.kind === "none"
      ? "none"
      : (reading.refusal ?? reading.actions.map((each) => each.key))
  }

  it("reads a program's name without regard to case, as PowerShell runs it", async () => {
    const push = ["push:r/app:origin/main"]
    expect(await shipped("git push origin main")).toEqual(push)
    expect(await shipped("GIT.EXE push origin main")).toEqual(push)
    expect(await shipped("Git push origin main")).toEqual(push)
    expect(await shipped("GH.EXE pr create --title t")).toEqual(["pr-create:r/app:@default"])
    // POSIX's reading doesn't take it for git: PowerShell's does.
    expect((await read("GIT push origin main")).kind).toBe("none")
  })

  it("reads a backslash as the character it is, so a quote after it closes its string", async () => {
    const command = 'echo "a\\"; git push origin main; echo "b"'
    // POSIX's quoting runs the string on past the semicolons and hides the push.
    expect((await read(command)).kind).toBe("none")
    expect((await ps(command)).kind).toBe("ships")
  })

  it("takes PowerShell's backtick escape as an expansion it can't read", async () => {
    expect(await shipped("git push origin main`n")).toMatch(/expansion/)
    expect(await shipped('git push "origin`" main"')).toMatch(/expansion/)
  })

  it("follows Set-Location as it does cd, and loses the folder at Pop-Location", async () => {
    expect(await shipped("Set-Location /w; git push origin feat/x", "/main")).toBe("none")
    expect(await shipped("Push-Location /w; git push origin feat/x", "/main")).toBe("none")
    expect(
      await shipped("Set-Location /w; Pop-Location; git push origin feat/x", "/main"),
    ).not.toBe("none")
  })

  it("refuses git or gh run through PowerShell's own wrappers", async () => {
    for (const command of [
      'Invoke-Expression "git push origin main"',
      'iex "GIT PUSH origin main"',
      'Start-Process git -ArgumentList "push origin main"',
    ])
      expect(await shipped(command), command).toMatch(/can't be read/)
  })
})
