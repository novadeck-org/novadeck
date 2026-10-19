import { context, describe, expect, it } from "../test"
import { dataFolderName, logsFolder } from "./data-folder"

describe("data folder name", () => {
  context("in a packaged app", () => {
    it("is novadeck", () => {
      expect(dataFolderName({ packaged: true })).toBe("novadeck")
    })
  })

  context("in development", () => {
    it("is a folder of its own, apart from an installed app's", () => {
      expect(dataFolderName({ packaged: false })).toBe("novadeck-dev")
    })
  })
})

describe("logs folder", () => {
  const launch = {
    home: "/home/ana",
    userData: "/home/ana/.config/novadeck",
    packaged: true,
    ownDataFolder: false,
  }

  context("on Linux and Windows", () => {
    it("is inside the data folder", () => {
      expect(logsFolder({ ...launch, platform: "linux" })).toBe("/home/ana/.config/novadeck/logs")
    })
  })

  context("on macOS", () => {
    it("is in the system's Logs folder, under the data folder's name", () => {
      expect(logsFolder({ ...launch, platform: "darwin", home: "/Users/ana" })).toBe(
        "/Users/ana/Library/Logs/novadeck",
      )
      expect(
        logsFolder({ ...launch, platform: "darwin", home: "/Users/ana", packaged: false }),
      ).toBe("/Users/ana/Library/Logs/novadeck-dev")
    })
  })

  context("with a data folder given on the command line", () => {
    it("is inside it, on every system", () => {
      expect(
        logsFolder({
          ...launch,
          platform: "darwin",
          userData: "/tmp/profile",
          ownDataFolder: true,
        }),
      ).toBe("/tmp/profile/logs")
    })
  })
})
