import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { createLogger, createRedactor, logPath, type Entry, type Logger } from "@novadeck/log"
import { afterEach } from "vitest"

import { openLogsChannel, uiErrorChannel } from "../bridge"
import { context, describe, expect, it } from "../test"
import {
  eachLine,
  goneBadly,
  goneData,
  installKind,
  logNewDumps,
  logRunnerOutput,
  registerLogIpc,
  uiErrorOf,
} from "./logs"

const folders: string[] = []
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const scratch = (): string => {
  const made = mkdtempSync(join(tmpdir(), "novadeck-host-log-"))
  folders.push(made)
  return made
}

/** A host's log in a fresh folder, redacted for a person named ana, and what it wrote. */
const hostLog = () => {
  const folder = scratch()
  const logger: Logger = createLogger({
    proc: "host",
    sid: "launch",
    file: { folder, name: "host" },
    redact: createRedactor({ home: "/home/ana", user: "ana", salt: "0".repeat(64) }),
    collapseMs: 0,
  })
  const lines = (): Entry[] => {
    try {
      return readFileSync(logPath(folder, "host"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    } catch {
      return []
    }
  }
  return { logger, lines }
}

describe("installKind", () => {
  const build = {
    packaged: true,
    platform: "linux" as NodeJS.Platform,
    appImage: false,
    execPath: "/opt/Novadeck/novadeck",
    inApplications: false,
    windowsInstalled: false,
  }

  it("names each kind of copy", () => {
    expect(installKind({ ...build, packaged: false })).toBe("development")
    expect(installKind({ ...build, appImage: true })).toBe("appimage")
    expect(installKind(build)).toBe("linux-package")
    expect(installKind({ ...build, execPath: "/home/ana/novadeck/novadeck" })).toBe(
      "linux-unpacked",
    )
    expect(installKind({ ...build, platform: "darwin", inApplications: true })).toBe(
      "mac-applications",
    )
    expect(installKind({ ...build, platform: "darwin" })).toBe("mac-elsewhere")
    expect(installKind({ ...build, platform: "win32", windowsInstalled: true })).toBe(
      "windows-installer",
    )
    expect(installKind({ ...build, platform: "win32" })).toBe("windows-portable")
  })
})

describe("a process that ended", () => {
  it("is told by its type, reason, exit code and name", () => {
    expect(
      goneData({
        type: "Utility",
        reason: "oom",
        exitCode: 9,
        serviceName: "node.mojom.NodeService",
        name: "Novadeck Runner",
      }),
    ).toEqual({
      type: "Utility",
      reason: "oom",
      exitCode: 9,
      service: "node.mojom.NodeService",
      name: "Novadeck Runner",
    })
  })

  it("ended badly unless it exited cleanly, a kill included", () => {
    expect(["crashed", "oom", "abnormal-exit", "launch-failed", "killed"].map(goneBadly)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect(goneBadly("clean-exit")).toBe(false)
  })
})

describe("the runner's output", () => {
  it("reaches the host's log line by line, redacted, as V8 reports running out of memory", async () => {
    const { logger, lines } = hostLog()
    const stderr = new PassThrough()
    const output = logRunnerOutput(logger.for("runner"))
    eachLine(stderr, (line) => output(2, "stderr", line))
    stderr.write("\n<--- Last few GCs --->\nFATAL ERROR: Reached heap lim")
    stderr.write("it Allocation failed - JavaScript heap out of memory\n")
    stderr.end(" 1: 0x5 node::Abort() [/home/ana/.local/share/acme/node]")
    await new Promise((resolve) => stderr.on("end", resolve))
    logger.close()
    const written = lines()
    expect(written.map((line) => [line.evt, line.level, line.data])).toEqual([
      ["runner.stderr", "warn", { run: 2 }],
      ["runner.stderr", "warn", { run: 2 }],
      ["runner.stderr", "warn", { run: 2 }],
    ])
    expect(written[1]?.msg).toBe(
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    )
    expect(written[2]?.msg).toMatch(
      /^ 1: 0x5 node::Abort\(\) \[~\/\.local\/share\/#[0-9a-f]{8}\/node\]$/,
    )
  })

  it("stops after its limit, saying so once", () => {
    const { logger, lines } = hostLog()
    const output = logRunnerOutput(logger.for("runner"), 2)
    for (let index = 0; index < 5; index += 1) output(1, "stdout", `line ${index}`)
    logger.close()
    expect(lines().map((line) => line.evt)).toEqual([
      "runner.stdout",
      "runner.stdout",
      "runner.output-dropped",
    ])
  })
})

describe("logNewDumps", () => {
  it("logs each crash report once, by its name and size, never what it holds", () => {
    const { logger, lines } = hostLog()
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
    const { logger, lines } = hostLog()
    logNewDumps(join(scratch(), "missing"), join(scratch(), "seen.json"), logger.for("crash"))
    logger.close()
    expect(lines()).toEqual([])
  })
})

describe("the page's logs and errors", () => {
  // An ipcMain that keeps its listeners, to call as the page would.
  const ipc = () => {
    const listeners = new Map<string, (event: unknown, value?: unknown) => void>()
    return {
      on: (channel: string, listener: (event: unknown, value?: unknown) => void) => {
        listeners.set(channel, listener)
      },
      send: (channel: string, own: boolean, value?: unknown) =>
        listeners.get(channel)?.({ own }, value),
    }
  }

  const setup = () => {
    const { logger, lines } = hostLog()
    const opened: string[] = []
    const fake = ipc()
    registerLogIpc(fake as never, {
      window: (event) => (event as unknown as { own: boolean }).own,
      openLogs: () => void opened.push("logs"),
      log: logger.for("page", "ui"),
    })
    return { logger, lines, opened, send: fake.send }
  }

  it("opens the logs folder for the app's own page alone", () => {
    const { logger, opened, send } = setup()
    send(openLogsChannel, false)
    send(openLogsChannel, true)
    logger.close()
    expect(opened).toEqual(["logs"])
  })

  it("logs an error the page didn't catch as the page's, redacted", () => {
    const { logger, lines, send } = setup()
    send(uiErrorChannel, true, {
      kind: "error",
      name: "TypeError",
      message: "x is undefined in /home/ana/acme/a.ts",
      stack: "TypeError: x is undefined\n    at f (index.js:1:2)",
    })
    send(uiErrorChannel, false, { kind: "error", name: "Error", message: "not ours" })
    logger.close()
    const written = lines()
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(
      expect.objectContaining({ proc: "ui", src: "page", evt: "ui.error", level: "error" }),
    )
    expect(written[0]?.err?.message).toMatch(
      /^x is undefined in ~\/#[0-9a-f]{8}\/#[0-9a-f]{8}\.ts$/,
    )
  })

  context("for a rejected promise whose reason quotes what it parsed", () => {
    it("keeps none of it", () => {
      const { logger, lines, send } = setup()
      send(uiErrorChannel, true, {
        kind: "rejection",
        name: "SyntaxError",
        message: "Unexpected token 'd', \"dear team, the merger\" is not valid JSON",
        stack: "SyntaxError: Unexpected token 'd', \"dear team, the merger\" is not valid JSON",
      })
      logger.close()
      const [line] = lines()
      expect(line?.evt).toBe("ui.rejection")
      expect(JSON.stringify(line)).not.toContain("merger")
    })
  })

  it("drops a report that is not one", () => {
    expect(uiErrorOf({ kind: "other", name: "x", message: "y" })).toBeUndefined()
    expect(uiErrorOf({ kind: "error", name: 1, message: "y" })).toBeUndefined()
    expect(uiErrorOf("boom")).toBeUndefined()
    expect(
      uiErrorOf({ kind: "error", name: "E", message: "m".repeat(5_000) })?.message,
    ).toHaveLength(2_000)
  })
})
