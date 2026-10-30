import { describe, expect, it } from "../../test"
import { appLog } from "./logs.test-support"
import { updateLogOn } from "./updates"

describe("the log of updating", () => {
  it("writes what updating says to the app's log, redacted, electron-updater's errors as errors", () => {
    const { logger, lines } = appLog()
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
