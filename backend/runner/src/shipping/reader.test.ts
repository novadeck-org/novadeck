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
})
