import { describe, expect, it } from "../../../test"
import { createDemoFolders, sampleFolder } from "./folders"

describe("demo folders", () => {
  it("asks with a default folder and gives back the path", async () => {
    const asked: string[] = []
    const { pickDirectory } = createDemoFolders((_message, initial) => {
      asked.push(initial)
      return "  ~/projects/shop "
    })
    expect(await pickDirectory()).toBe("~/projects/shop")
    expect(asked).toEqual([sampleFolder])
  })

  it("gives null when cancelled or left empty", async () => {
    expect(await createDemoFolders(() => null).pickDirectory()).toBeNull()
    expect(await createDemoFolders(() => "  ").pickDirectory()).toBeNull()
  })

  it("rejects once when armed to fail", async () => {
    const { pickDirectory, failNext } = createDemoFolders(() => "~/a")
    failNext()
    await expect(pickDirectory()).rejects.toThrow()
    expect(await pickDirectory()).toBe("~/a")
  })
})
