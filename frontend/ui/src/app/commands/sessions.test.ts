import { describe, expect, it } from "../../test"
import { folderName } from "./sessions"

describe("folder name", () => {
  it("is the last segment of a POSIX or Windows path", () => {
    expect(
      ["/home/alex/storefront", "/home/alex/storefront/", "C:\\work\\api", "D:\\work\\api\\"].map(
        folderName,
      ),
    ).toEqual(["storefront", "storefront", "api", "api"])
  })

  it("keeps a root as it is", () => {
    expect(["/", "C:\\"].map(folderName)).toEqual(["/", "C:"])
  })
})
