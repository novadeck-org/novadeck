import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../../test"
import { logNewDumps } from "./crash-dumps"
import { appLog, scratch } from "./logs.test-support"

describe("logNewDumps", () => {
  it("logs each crash report once, by its name and size, never what it holds", () => {
    const { logger, lines } = appLog()
    const dumps = scratch()
    const seen = join(scratch(), "crash-dumps.json")
    mkdirSync(join(dumps, "completed"))
    writeFileSync(join(dumps, "completed", "first.dmp"), "MDMP secret memory")
    logNewDumps(dumps, seen, logger.for("crash"))
    logNewDumps(dumps, seen, logger.for("crash"))
    writeFileSync(join(dumps, "completed", "second.dmp"), "MDMP")
    logNewDumps(dumps, seen, logger.for("crash"))
    logger.close()
    const written = lines()
    expect(written.map((line) => [line.evt, line.data?.name, line.data?.size])).toEqual([
      ["crash.dump", "first.dmp", 18],
      ["crash.dump", "second.dmp", 4],
    ])
    expect(JSON.stringify(written)).not.toContain("secret memory")
  })

  it("logs nothing where Crashpad kept nothing", () => {
    const { logger, lines } = appLog()
    logNewDumps(join(scratch(), "missing"), join(scratch(), "seen.json"), logger.for("crash"))
    logger.close()
    expect(lines()).toEqual([])
  })
})
