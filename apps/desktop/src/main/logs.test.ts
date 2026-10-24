import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { createLogger, createRedactor, logPath, type Entry, type Logger } from "@novadeck/log"
import { afterEach } from "vitest"

import { openLogsChannel, rendererPoolChannel, uiErrorChannel } from "../bridge"
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
  updateLogOn,
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
  // Feeds `stderr` through to the log as the host does, and waits for it to end.
  const pipe = async (
    output: ReturnType<typeof logRunnerOutput>,
    run: number,
    chunks: string[],
  ) => {
    const stderr = new PassThrough()
    eachLine(
      stderr,
      (line) => output.line(run, "stderr", line),
      () => output.end(run, "stderr"),
    )
    const ended = new Promise((resolve) => stderr.on("end", resolve))
    for (const chunk of chunks.slice(0, -1)) stderr.write(chunk)
    stderr.end(chunks.at(-1))
    await ended
  }

  it("reaches the host's log line by line, redacted, as V8 reports running out of memory", async () => {
    const { logger, lines } = hostLog()
    await pipe(logRunnerOutput(logger.for("runner")), 2, [
      "\n<--- Last few GCs --->\nFATAL ERROR: Reached heap lim",
      "it Allocation failed - JavaScript heap out of memory\n",
      " 1: 0x5 node::Abort() [/home/ana/.local/share/acme/node]",
    ])
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

  it("withholds the source Node prints of an error nothing caught, and what a JSON.parse was given", async () => {
    const { logger, lines } = hostLog()
    // As Node prints a JSON.parse of a message's body that nothing caught.
    await pipe(logRunnerOutput(logger.for("runner")), 1, [
      "<anonymous_script>:1\n",
      '{"body": "meet at Acme HQ re merger"\n',
      "^\n\n",
      'SyntaxError: Unexpected end of JSON input, "meet at Acme HQ re merger"\n',
      "    at JSON.parse (<anonymous>)",
    ])
    logger.close()
    const written = lines().map((line) => line.msg)
    expect(JSON.stringify(written)).not.toContain("merger")
    expect(written).toEqual([
      "<anonymous_script>:1",
      "(a source line was withheld)",
      "SyntaxError: Unexpected end of JSON input (input withheld)",
      "    at JSON.parse (<anonymous>)",
    ])
  })

  it("past its limit, says so, and keeps the last lines for when the stream ends", async () => {
    const { logger, lines } = hostLog()
    const output = logRunnerOutput(logger.for("runner"), 2)
    await pipe(output, 1, [
      ...Array.from({ length: 6 }, (_, index) => `chatter ${index}\n`),
      "FATAL ERROR: Reached heap limit\n",
    ])
    // A crash later, and the runner started again: its output is logged afresh.
    await pipe(output, 2, ["starting again"])
    logger.close()
    expect(lines().map((line) => [line.evt, line.msg ?? "", line.data?.run])).toEqual([
      ["runner.stderr", "chatter 0", 1],
      ["runner.stderr", "chatter 1", 1],
      ["runner.stderr-capped", "The runner wrote more than the log keeps.", 1],
      ["runner.stderr-tail", "The last lines the runner wrote past the limit.", 1],
      ["runner.stderr", "chatter 2", 1],
      ["runner.stderr", "chatter 3", 1],
      ["runner.stderr", "chatter 4", 1],
      ["runner.stderr", "chatter 5", 1],
      ["runner.stderr", "FATAL ERROR: Reached heap limit", 1],
      ["runner.stderr", "starting again", 2],
    ])
  })
})

describe("the log of updating", () => {
  it("writes what updating says to the host's log, redacted, electron-updater's errors as errors", () => {
    const { logger, lines } = hostLog()
    const updates = updateLogOn(logger.for("updates"))
    updates.info("1.2.3 is ready to install on quitting.")
    updates.warn("Installing the update failed.", new Error("EACCES /home/ana/apps/x"))
    updates.logger.info({ files: 2 })
    updates.logger.error(new Error("net::ERR_TIMED_OUT"))
    logger.close()
    expect(lines().map((line) => [line.src, line.evt, line.level, line.msg])).toEqual([
      ["updates", "update.progress", "info", "1.2.3 is ready to install on quitting."],
      ["updates", "update.warning", "warn", "Installing the update failed."],
      ["updates", "updater.info", "info", "{ files: 2 }"],
      ["updates", "updater.error", "error", "electron-updater reported an error."],
    ])
    expect(lines()[1]?.err?.message).toMatch(/^EACCES ~\/#[0-9a-f]{8}\/#[0-9a-f]{8}$/)
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

  it("logs the counts of the page's WebGL pool, from the app's own page, as numbers only", () => {
    const { logger, lines, send } = setup()
    const counts = { waits: 2, steals: 1, swaps: 9, lost: 0, failed: 0, resizes: 3, onDom: 1 }
    send(rendererPoolChannel, true, counts)
    send(rendererPoolChannel, false, counts)
    send(rendererPoolChannel, true, { ...counts, swaps: "9" })
    send(rendererPoolChannel, true, { ...counts, waits: -1 })
    send(rendererPoolChannel, true, { waits: 1 })
    logger.close()
    const written = lines()
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(
      expect.objectContaining({ proc: "ui", evt: "ui.renderer-pool", level: "info", data: counts }),
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
