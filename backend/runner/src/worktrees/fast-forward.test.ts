import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { gitIn, withOrigin, type Origin } from "../testing/origin.js"
import { fastForward } from "./fast-forward.js"

const it = base.extend<{ origin: Origin; hooks: string }>({
  origin: async ({ resources }, use) => {
    await use(withOrigin((cleanup) => resources.defer(cleanup)))
  },
  hooks: async ({ resources }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "novadeck-test-hooks-"))
    resources.defer(() => rmSync(dir, { recursive: true, force: true }))
    await use(dir)
  },
})

const head = (repo: string) => gitIn(repo, "rev-parse", "HEAD")

describe("fast-forwarding a checkout", () => {
  it("moves a clean checkout on main to origin's main, leaving untracked files", async ({
    origin,
    hooks,
  }) => {
    const first = head(origin.repo)
    const landed = origin.land("b.txt")
    origin.fetch()
    writeFileSync(join(origin.repo, "scratch.txt"), "mine\n")
    expect(await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })).toEqual({
      ok: true,
      moved: true,
      from: first,
      to: landed,
    })
    expect(head(origin.repo)).toBe(landed)
    expect(existsSync(join(origin.repo, "b.txt"))).toBe(true)
    expect(existsSync(join(origin.repo, "scratch.txt"))).toBe(true)
    expect(await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })).toEqual({
      ok: true,
      moved: false,
    })
  })

  it("runs none of the repository's hooks", async ({ origin, hooks }) => {
    const marker = join(origin.repo, "hook-ran")
    const hook = join(origin.repo, ".git", "hooks", "post-merge")
    mkdirSync(join(origin.repo, ".git", "hooks"), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replaceAll("\\", "/")}"\n`)
    chmodSync(hook, 0o755)
    const landed = origin.land("b.txt")
    origin.fetch()
    await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })
    expect(head(origin.repo)).toBe(landed)
    expect(existsSync(marker)).toBe(false)
  })

  it("runs no hook of a folder the repository's own config points at, nor a reference-transaction", async ({
    origin,
    hooks,
  }) => {
    const mine = join(origin.repo, "my-hooks")
    mkdirSync(mine)
    const marker = join(origin.repo, "hook-ran").replaceAll("\\", "/")
    for (const name of ["post-merge", "reference-transaction", "post-checkout"]) {
      writeFileSync(join(mine, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`)
      chmodSync(join(mine, name), 0o755)
    }
    gitIn(origin.repo, "config", "core.hooksPath", mine.replaceAll("\\", "/"))
    const landed = origin.land("b.txt")
    origin.fetch()
    // Git's own fetch ran the reference-transaction hook, so the marker is there to clear.
    rmSync(join(origin.repo, "hook-ran"), { force: true })
    await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })
    expect(head(origin.repo)).toBe(landed)
    expect(existsSync(join(origin.repo, "hook-ran"))).toBe(false)
  })

  it("leaves a checkout with tracked changes, staged or not, unless allowed", async ({
    origin,
    hooks,
  }) => {
    const landed = origin.land("b.txt")
    origin.fetch()
    const before = head(origin.repo)
    const options = { hooks: () => Promise.resolve(hooks) }
    writeFileSync(join(origin.repo, "a.txt"), "changed\n")
    expect(await fastForward(origin.repo, options)).toMatchObject({ ok: false })
    gitIn(origin.repo, "add", "a.txt")
    expect(await fastForward(origin.repo, options)).toMatchObject({ ok: false })
    expect(head(origin.repo)).toBe(before)
    expect(await fastForward(origin.repo, { ...options, allowChanges: true })).toEqual({
      ok: true,
      moved: true,
      from: before,
      to: landed,
    })
    expect(head(origin.repo)).toBe(landed)
  })

  it("lets git refuse where a change is in the way, even when allowed", async ({
    origin,
    hooks,
  }) => {
    const other = origin.land("a.txt")
    origin.fetch()
    writeFileSync(join(origin.repo, "a.txt"), "mine\n")
    const before = head(origin.repo)
    const done = await fastForward(origin.repo, {
      hooks: () => Promise.resolve(hooks),
      allowChanges: true,
    })
    expect(done).toEqual({ ok: false, said: "Your changes to a.txt would be overwritten." })
    expect(head(origin.repo)).toBe(before)
    expect(other).not.toBe(before)
  })

  it("waits while an operation is in progress or a lock is held", async ({ origin, hooks }) => {
    const landed = origin.land("b.txt")
    origin.fetch()
    const options = { hooks: () => Promise.resolve(hooks), allowChanges: true }
    const before = head(origin.repo)
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "index.lock",
    ]) {
      const file = join(origin.repo, ".git", name)
      writeFileSync(file, "x\n")
      // eslint-disable-next-line no-await-in-loop -- One marker at a time.
      expect(await fastForward(origin.repo, options)).toMatchObject({ ok: false })
      rmSync(file)
    }
    for (const name of ["rebase-merge", "rebase-apply", "sequencer"]) {
      const dir = join(origin.repo, ".git", name)
      mkdirSync(dir)
      // eslint-disable-next-line no-await-in-loop -- One marker at a time.
      expect(await fastForward(origin.repo, options)).toMatchObject({ ok: false })
      rmSync(dir, { recursive: true })
    }
    expect(head(origin.repo)).toBe(before)
    expect(await fastForward(origin.repo, options)).toMatchObject({ ok: true, moved: true })
    expect(head(origin.repo)).toBe(landed)
  })

  it("does nothing on a main that is ahead or diverged, wherever the checkout is", async ({
    origin,
    hooks,
  }) => {
    origin.land("b.txt")
    origin.fetch()
    const options = { hooks: () => Promise.resolve(hooks) }
    const untouched = async () => {
      const before = [head(origin.repo), gitIn(origin.repo, "rev-parse", "refs/heads/main")]
      expect(await fastForward(origin.repo, options)).toEqual({ ok: true, moved: false })
      expect([head(origin.repo), gitIn(origin.repo, "rev-parse", "refs/heads/main")]).toEqual(
        before,
      )
    }
    writeFileSync(join(origin.repo, "mine.txt"), "mine\n")
    gitIn(origin.repo, "add", "-A")
    gitIn(origin.repo, "commit", "--quiet", "-m", "mine")
    await untouched()
    gitIn(origin.repo, "checkout", "--quiet", "-b", "feature")
    await untouched()
    gitIn(origin.repo, "checkout", "--quiet", "--detach")
    await untouched()
  })

  it("moves only the local main branch where the checkout is on another branch or none", async ({
    origin,
    hooks,
  }) => {
    const options = { hooks: () => Promise.resolve(hooks) }
    const first = head(origin.repo)
    const second = origin.land("b.txt")
    origin.fetch()
    gitIn(origin.repo, "checkout", "--quiet", "-b", "feature")
    expect(await fastForward(origin.repo, options)).toEqual({
      ok: true,
      moved: true,
      from: first,
      to: second,
      ref: true,
    })
    expect(gitIn(origin.repo, "rev-parse", "refs/heads/main")).toBe(second)
    expect(head(origin.repo)).toBe(first)
    expect(existsSync(join(origin.repo, "b.txt"))).toBe(false)
    const third = origin.land("c.txt")
    origin.fetch()
    gitIn(origin.repo, "checkout", "--quiet", "--detach")
    expect(await fastForward(origin.repo, options)).toMatchObject({ moved: true, to: third })
    expect(gitIn(origin.repo, "rev-parse", "refs/heads/main")).toBe(third)
    expect(await fastForward(origin.repo, options)).toEqual({ ok: true, moved: false })
  })

  it("leaves a main that another worktree has checked out", async ({ origin, hooks }) => {
    const first = head(origin.repo)
    origin.land("b.txt")
    origin.fetch()
    gitIn(origin.repo, "checkout", "--quiet", "-b", "feature")
    const linked = join(origin.repo, "..", "linked")
    gitIn(origin.repo, "worktree", "add", "--quiet", linked, "main")
    const done = await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })
    expect(done).toMatchObject({ ok: false, said: expect.stringContaining("main is checked out") })
    expect(gitIn(origin.repo, "rev-parse", "refs/heads/main")).toBe(first)
  })

  it("runs no reference-transaction hook while it moves the ref", async ({ origin, hooks }) => {
    const mine = join(origin.repo, "my-hooks")
    mkdirSync(mine)
    const marker = join(origin.repo, "hook-ran").replaceAll("\\", "/")
    writeFileSync(join(mine, "reference-transaction"), `#!/bin/sh\necho ran >> "${marker}"\n`)
    chmodSync(join(mine, "reference-transaction"), 0o755)
    gitIn(origin.repo, "config", "core.hooksPath", mine.replaceAll("\\", "/"))
    const landed = origin.land("b.txt")
    origin.fetch()
    gitIn(origin.repo, "checkout", "--quiet", "-b", "feature")
    rmSync(join(origin.repo, "hook-ran"), { force: true })
    await fastForward(origin.repo, { hooks: () => Promise.resolve(hooks) })
    expect(gitIn(origin.repo, "rev-parse", "refs/heads/main")).toBe(landed)
    expect(existsSync(join(origin.repo, "hook-ran"))).toBe(false)
  })
})
