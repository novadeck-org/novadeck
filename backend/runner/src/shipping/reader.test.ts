/* eslint-disable no-await-in-loop -- Each case reads one command. */
import { describe, expect, it } from "vitest"

import { readCommand, type Lookups } from "./reader.js"

// A repository `r/app` whose checkout at /w is on `feat/x` (the agent's own), and /main on main.
const lookups: Lookups = {
  branch: async (cwd) => (cwd === "/main" ? "main" : cwd === "/w" ? "feat/x" : undefined),
  upstream: async (_cwd, branch) =>
    branch === "main" ? { remote: "origin", branch: "main" } : undefined,
  repo: async () => "r/app",
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
      "git push --mirror",
      "git push --tags origin",
      "git push origin :main",
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push --delete origin main",
      "git -c core.sshCommand=x push origin main",
      "GIT_SSH_COMMAND=x git push origin main",
      "git push --receive-pack=x origin main",
      "git merge -s custom x",
      "gh pr merge 12 --admin",
      "gh api -X POST repos/r/app/merges",
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
    expect(await keys("gh pr merge https://github.com/other/repo/pull/12")).toMatch(
      /names other\/repo/,
    )
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
      "gh pr merge 12 --admin=true",
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
    expect(await keys("git update-ref -d refs/heads/main")).toMatch(/update-ref/)
    expect(await keys("git update-ref --stdin")).toMatch(/update-ref/)
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
    for (const command of [
      "git fetch . 'refs/heads/*:refs/heads/*'",
      "git fetch . x:refs/tags/v1",
      "git branch -f main HEAD --contains x",
      "git rebase -x 'make' main",
      "git rebase --exec=make main",
      "gh release create v1.0 --notes x",
      "gh api -XPOST repos/r/app/merges",
      "gh api --method=PATCH repos/r/app",
      "gh api --method DELETE repos/r/app",
      "gh api repos/r/app -X put",
      "gh api -X POST repos/r/app",
      "gh api repos/r/app -f title=x",
    ]) {
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
})
