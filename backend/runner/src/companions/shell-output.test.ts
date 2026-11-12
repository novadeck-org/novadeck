import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { companionLimits, itemContent } from "@novadeck/protocol"
import type { ItemContent } from "@novadeck/protocol"

import type { Shell } from "../harnesses/shells.js"
import { describe, expect, it as base } from "../test.js"
import { ShellTails, shellsDetail } from "./shell-output.js"

const it = base.extend<{ directory: string; tails: ShellTails }>({
  directory: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-shell-output-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
  tails: async ({ directory }, use) => {
    void directory
    await use(new ShellTails())
  },
})

const shell = (id: string, output?: string, exit: Shell["exit"] = null): Shell => ({
  id,
  command: `run ${id}`,
  since: 1,
  exit,
  ...(output !== undefined && { output }),
})

/** The output of each shell, as the content gives it. */
const outputs = (content: ItemContent) => {
  if (content.state !== "ready" || content.content.kind !== "shells") throw new Error("no shells")
  return content.content.shells.map(({ output }) => output)
}

const read = (tails: ShellTails, ...shells: Shell[]) => tails.content({ agent: "codex", shells })

describe("the end of background shells' output", () => {
  it("is the last lines of a file, numbered as they are in it", async ({ directory, tails }) => {
    const path = join(directory, "out.log")
    writeFileSync(path, Array.from({ length: 1000 }, (_, at) => `line ${at + 1}\n`).join(""))
    const content = await read(tails, shell("1", path))
    expect(itemContent.safeParse(content).success).toBe(true)
    const [output] = outputs(content)
    expect(output).toMatchObject({ state: "ready", firstLine: 601, total: 1000 })
    expect(output).toMatchObject({ lines: expect.arrayContaining(["line 601", "line 1000"]) })
    expect(output?.state === "ready" && output.lines).toHaveLength(companionLimits.shellLines)
  })

  it("counts a last line no line feed ends, and none for an empty file", async ({
    directory,
    tails,
  }) => {
    const [open, empty, feeds] = ["open.log", "empty.log", "feeds.log"].map((name) =>
      join(directory, name),
    ) as [string, string, string]
    writeFileSync(open, "one\ntwo")
    writeFileSync(empty, "")
    writeFileSync(feeds, "one\n\n\n")
    expect(
      outputs(await read(tails, shell("1", open), shell("2", empty), shell("3", feeds))),
    ).toEqual([
      { state: "ready", firstLine: 1, lines: ["one", "two"], total: 2 },
      { state: "ready", firstLine: 1, lines: [], total: 0 },
      { state: "ready", firstLine: 1, lines: ["one", "", ""], total: 3 },
    ])
  })

  it("cuts a line to the protocol's length, and shows a rewritten line as a terminal would", async ({
    directory,
    tails,
  }) => {
    const path = join(directory, "out.log")
    writeFileSync(path, `${"x".repeat(5000)}\nprogress 10%\rprogress 90%\r\nwin\r\n`)
    const [output] = outputs(await read(tails, shell("1", path)))
    expect(output).toMatchObject({
      state: "ready",
      total: 3,
      lines: ["x".repeat(companionLimits.lineLength), "progress 90%", "win"],
    })
  })

  it("follows a file that grows, counting only what was added", async ({ directory, tails }) => {
    const path = join(directory, "out.log")
    writeFileSync(path, "a\nb\n")
    await read(tails, shell("1", path))
    // Changed in place and kept as long, then grown: the count of what was read before
    // stands, which a recount from the start (5 lines) would not give.
    writeFileSync(path, "\n\n\n\n")
    appendFileSync(path, "c\n")
    const [output] = outputs(await read(tails, shell("1", path)))
    expect(output).toMatchObject({ total: 3, firstLine: 1 })
  })

  it("counts afresh a file that shrank or was replaced", async ({ directory, tails }) => {
    const path = join(directory, "out.log")
    writeFileSync(path, "a\nb\nc\nd\n")
    await read(tails, shell("1", path))
    truncateSync(path, 4)
    expect(outputs(await read(tails, shell("1", path)))).toEqual([
      { state: "ready", firstLine: 1, lines: ["a", "b"], total: 2 },
    ])
    rmSync(path)
    writeFileSync(path, "new\n")
    expect(outputs(await read(tails, shell("1", path)))).toEqual([
      { state: "ready", firstLine: 1, lines: ["new"], total: 1 },
    ])
  })

  it("is none where a shell has no file, or a path is no file, and gone where it went", async ({
    directory,
    tails,
  }) => {
    const folder = join(directory, "folder")
    mkdirSync(folder)
    expect(
      outputs(
        await read(
          tails,
          shell("1"),
          shell("2", folder),
          shell("3", join(directory, "missing.log")),
        ),
      ),
    ).toEqual([{ state: "none" }, { state: "none" }, { state: "gone" }])
  })

  it("keeps all its shells within the text limit, trimming the largest tails first", async ({
    directory,
    tails,
  }) => {
    const small = join(directory, "small.log")
    writeFileSync(small, "ok\n".repeat(10))
    const shells = [shell("small", small)]
    for (let at = 0; at < 4; at += 1) {
      const big = join(directory, `big${at}.log`)
      writeFileSync(big, `${"y".repeat(4000)}\n`.repeat(400))
      shells.push(shell(`big${at}`, big))
    }
    const content = await read(tails, ...shells)
    expect(itemContent.safeParse(content).success).toBe(true)
    const [first, ...bigs] = outputs(content)
    // The small one is whole; the big ones lost their oldest lines, so they start later.
    expect(first).toMatchObject({ firstLine: 1, total: 10 })
    const held = bigs.flatMap((output) => (output.state === "ready" ? output.lines : []))
    expect(held.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(
      companionLimits.shellsText,
    )
    for (const output of bigs)
      expect(output).toMatchObject({ state: "ready", total: 400, firstLine: expect.any(Number) })
    expect(bigs.some((output) => output.state === "ready" && output.firstLine > 1)).toBe(true)
    // The last line of each stays: it is the oldest that go.
    for (const output of bigs) expect(output.state === "ready" && output.lines.at(-1)).toBeTruthy()
  })

  it("has a stamp that changes as a shell or its file does, and only then", async ({
    directory,
    tails,
  }) => {
    const path = join(directory, "out.log")
    writeFileSync(path, "a\n")
    const stamp = async (...shells: Shell[]) => {
      const content = await read(tails, ...shells)
      return content.state === "ready" ? content.stamp : ""
    }
    const first = await stamp(shell("1", path))
    expect(await stamp(shell("1", path))).toBe(first)
    appendFileSync(path, "b\n")
    const grown = await stamp(shell("1", path))
    expect(grown).not.toBe(first)
    expect(await stamp(shell("1", path, { at: 5, code: 0 }))).not.toBe(grown)
    expect(await stamp(shell("1", path), shell("2"))).not.toBe(grown)
    rmSync(path)
    expect(await stamp(shell("1", path))).not.toBe(grown)
  })
})

describe("what the shells together say", () => {
  it("counts those running and those that failed", () => {
    const [run, ok, bad, unknown] = [
      shell("1"),
      shell("2", undefined, { at: 1, code: 0 }),
      shell("3", undefined, { at: 1, code: 2 }),
      shell("4", undefined, { at: 1, code: null }),
    ] as const
    expect(shellsDetail([run, run, run])).toBe("3 running")
    expect(shellsDetail([run, run, bad])).toBe("2 running · 1 failed")
    expect(shellsDetail([ok, bad])).toBe("1 failed")
    expect(shellsDetail([ok, unknown])).toBe("ended")
  })
})
