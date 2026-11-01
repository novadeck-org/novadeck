import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { matchCall, type GitLookups, type GrantScope } from "@novadeck/harness-core/grants"
import { describe, expect, it } from "vitest"

import { fsLookups } from "./fs-lookups.js"
import { gitLookups, rewrittenPushUrl } from "./git-lookups.js"
import { programPath } from "./programs.js"

const granted = "https://github.com/acme/app"
const scope: GrantScope = {
  presets: ["push"],
  commands: [],
  repos: [{ url: "github.com/acme/app", defaultBranch: "main" }],
}

// A scratch repo pushing to a bare one, with the branch `fix` and the tag `v1.0.0`.
const scratch = () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-git-lookups-")))
  const bare = join(base, "remote.git")
  const local = join(base, "local")
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: join(base, "none"),
    GIT_CONFIG_NOSYSTEM: "1",
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  mkdirSync(bare)
  git(bare, "init", "--bare", "-q")
  mkdirSync(local)
  git(local, "init", "-q", "-b", "work")
  git(local, "commit", "-q", "--allow-empty", "-m", "one")
  git(local, "branch", "fix")
  git(local, "tag", "v1.0.0")
  git(local, "remote", "add", "origin", bare)
  const remoteRefs = () =>
    git(bare, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).toSorted()
  return {
    base,
    local,
    git,
    remoteRefs,
    done: () => rmSync(base, { recursive: true, force: true }),
  }
}

describe("the git lookups", () => {
  it("resolve a name to the full ref it is, and a missing name to null", async () => {
    const { local, done } = scratch()
    try {
      expect(await gitLookups.resolve(local, "fix")).toBe("refs/heads/fix")
      expect(await gitLookups.resolve(local, "HEAD")).toBe("refs/heads/work")
      expect(await gitLookups.resolve(local, "v1.0.0")).toBe("refs/tags/v1.0.0")
      expect(await gitLookups.resolve(local, "tags/v1.0.0")).toBe("refs/tags/v1.0.0")
      expect(await gitLookups.resolve(local, "nothing")).toBeNull()
      expect(await gitLookups.resolve(local, "-x")).toBeUndefined()
      expect(await gitLookups.resolve(join(local, "gone"), "fix")).toBeUndefined()
    } finally {
      done()
    }
  })

  it("name the push URLs of a remote", async () => {
    const { local, base, done } = scratch()
    try {
      expect(await gitLookups.pushUrls(local, "origin")).toEqual([join(base, "remote.git")])
      expect(await gitLookups.pushUrls(local, "nowhere")).toBeUndefined()
    } finally {
      done()
    }
  })

  // The matcher decides on the real git's answers; the push itself then runs for real in a
  // scratch repo, so what git would create is what is held up against what the matcher let by.
  describe("the push preset, against a real push", () => {
    const grantedRemote = (local: string): GitLookups => ({
      ...gitLookups,
      pushUrls: async (cwd, remote) =>
        cwd === local && remote === "origin" ? [granted] : undefined,
    })

    it("lets no tag be created, and still takes a branch", async () => {
      const { local, git, remoteRefs, done } = scratch()
      try {
        const matched = (refspec: string) =>
          matchCall(
            { command: `git push origin ${refspec}`, cwd: local },
            [scope],
            grantedRemote(local),
            local,
            fsLookups,
          )
        // Without the matcher these create `refs/tags/…` on the remote: the control.
        for (const refspec of ["v1.0.0:v9.9.9", "tags/v1.0.0:release-2"]) {
          // eslint-disable-next-line no-await-in-loop -- One push at a time.
          expect(await matched(refspec), refspec).toBeNull()
          git(local, "push", "-q", "origin", refspec)
        }
        expect(remoteRefs()).toEqual(["refs/tags/release-2", "refs/tags/v9.9.9"])
        // A destination that names a local tag is held back too.
        expect(await matched("fix:v1.0.0")).toBeNull()
        // A branch, or HEAD, still matches, and git makes a branch of it.
        for (const refspec of ["fix:feat-a", "HEAD:feat-b"]) {
          // eslint-disable-next-line no-await-in-loop -- As above.
          expect(await matched(refspec), refspec).not.toBeNull()
          git(local, "push", "-q", "origin", refspec)
        }
        expect(remoteRefs()).toEqual([
          "refs/heads/feat-a",
          "refs/heads/feat-b",
          "refs/tags/release-2",
          "refs/tags/v9.9.9",
        ])
      } finally {
        done()
      }
    })

    const matcher = (local: string, command: string) =>
      matchCall({ command, cwd: local }, [scope], grantedRemote(local), local, fsLookups)

    it("refuses a HEAD that points at a tag, which would create one", async () => {
      const { local, git, remoteRefs, done } = scratch()
      try {
        expect(await matcher(local, "git push origin HEAD:v9")).not.toBeNull()
        // The agent writes `ref: refs/tags/v1.0.0` into .git/HEAD.
        git(local, "symbolic-ref", "HEAD", "refs/tags/v1.0.0")
        expect(await gitLookups.resolve(local, "HEAD")).toBe("refs/tags/v1.0.0")
        expect(await matcher(local, "git push origin HEAD:v9")).toBeNull()
        // The control: git makes a tag of it.
        git(local, "push", "-q", "origin", "HEAD:v9")
        expect(remoteRefs()).toEqual(["refs/tags/v9"])
      } finally {
        done()
      }
    })

    it("sends no tag along: push.followTags needs --no-follow-tags", async () => {
      const { local, git, remoteRefs, done } = scratch()
      try {
        git(local, "tag", "-a", "-m", "release", "rel-1", "fix")
        expect(await matcher(local, "git push origin fix:feat-a")).not.toBeNull()
        git(local, "config", "push.followTags", "true")
        expect(await gitLookups.followsTags(local)).toBe(true)
        expect(await matcher(local, "git push origin fix:feat-a")).toBeNull()
        expect(await matcher(local, "git push --no-follow-tags origin fix:feat-a")).not.toBeNull()
        // The flag keeps the annotated tag at home; without it git sends it with the branch.
        git(local, "push", "-q", "--no-follow-tags", "origin", "fix:feat-a")
        expect(remoteRefs()).toEqual(["refs/heads/feat-a"])
        git(local, "push", "-q", "origin", "fix:feat-b")
        expect(remoteRefs()).toEqual(["refs/heads/feat-a", "refs/heads/feat-b", "refs/tags/rel-1"])
      } finally {
        done()
      }
    })

    it("reads a URL as the folder's insteadOf and pushInsteadOf rewrite it", async () => {
      const { local, base, git, remoteRefs, done } = scratch()
      try {
        const bare = join(base, "remote.git")
        const push = `git push ${granted} fix:feat-a`
        expect(await gitLookups.pushTarget(local, granted)).toBe(granted)
        expect(await matcher(local, push)).not.toBeNull()
        // The granted URL now reaches another repository: git pushes to the scratch one.
        git(local, "config", `url.${bare}.insteadOf`, granted)
        expect(await gitLookups.pushTarget(local, granted)).toBe(bare)
        expect(await matcher(local, push)).toBeNull()
        git(local, "push", "-q", granted, "fix:feat-a")
        expect(remoteRefs()).toEqual(["refs/heads/feat-a"])
        // pushInsteadOf wins for a push, and a longer prefix wins over a shorter.
        git(local, "config", "--unset", `url.${bare}.insteadOf`)
        git(
          local,
          "config",
          "url.https://github.com/evil/.pushInsteadOf",
          "https://github.com/acme/",
        )
        expect(await gitLookups.pushTarget(local, granted)).toBe("https://github.com/evil/app")
        expect(await matcher(local, push)).toBeNull()
      } finally {
        done()
      }
    })
  })
})

describe("the program lookup", () => {
  it("finds a program by an absolute PATH entry, never by a relative one or the working folder", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-programs-")))
    const saved = process.env.PATH
    try {
      const name = process.platform === "win32" ? "tool-x.exe" : "tool-x"
      mkdirSync(join(base, "bin"))
      writeFileSync(join(base, "bin", name), "")
      chmodSync(join(base, "bin", name), 0o755)
      writeFileSync(join(base, name), "")
      process.env.PATH = ["", "bin", base].join(delimiter)
      // `bin` is relative and the empty entry means the working folder: neither counts.
      expect(programPath("tool-x")).toBe(join(base, name))
      process.env.PATH = ["", "bin"].join(delimiter)
      expect(programPath("tool-x")).toBeUndefined()
      process.env.PATH = [join(base, "bin")].join(delimiter)
      expect(programPath("tool-x")).toBe(join(base, "bin", name))
      expect(programPath("tool-y")).toBeUndefined()
    } finally {
      process.env.PATH = saved
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("a URL as git push reads it", () => {
  const entries = (...pairs: [string, string][]) => pairs.map(([k, v]) => `${k}\n${v}\0`).join("")

  it("is the URL itself without a rule, and an unrelated rule changes nothing", () => {
    expect(rewrittenPushUrl("https://github.com/a/b", "")).toBe("https://github.com/a/b")
    expect(
      rewrittenPushUrl(
        "https://github.com/a/b",
        entries(["url.git@x:.insteadof", "https://gitlab.com/"]),
      ),
    ).toBe("https://github.com/a/b")
  })

  it("takes the longest matching prefix, and pushInsteadOf before insteadOf", () => {
    const url = "https://github.com/acme/app"
    expect(
      rewrittenPushUrl(
        url,
        entries(
          ["url.A/.insteadof", "https://github.com/"],
          ["url.B/.insteadof", "https://github.com/acme/"],
        ),
      ),
    ).toBe("B/app")
    expect(
      rewrittenPushUrl(
        url,
        entries(
          ["url.B/.insteadof", "https://github.com/acme/"],
          ["url.P/.pushinsteadof", "https://"],
        ),
      ),
    ).toBe("P/github.com/acme/app")
  })

  it("keeps a base that holds dots", () => {
    expect(rewrittenPushUrl("gh:a/b", entries(["url.https://github.com/.insteadof", "gh:"]))).toBe(
      "https://github.com/a/b",
    )
  })
})
