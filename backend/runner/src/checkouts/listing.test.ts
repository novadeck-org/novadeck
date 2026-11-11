import { describe, expect, it } from "../test.js"
import { parseListing } from "./listing.js"

describe("a listing, parsed", () => {
  it("reads git's raw and numstat listings together, with renames, binary files and objects", () => {
    const out = [
      ":100644 100644 aaa bbb M",
      "a.txt",
      ":100644 000000 aaa 000 D",
      "g.txt",
      ":100644 100644 aaa bbb R085",
      "r.txt",
      "q.txt",
      ":100644 100644 aaa bbb M",
      "img.png",
      "1\t1\ta.txt",
      "0\t1\tg.txt",
      "2\t0\t",
      "r.txt",
      "q.txt",
      "-\t-\timg.png",
      "",
    ].join("\0")
    expect(parseListing(out)).toEqual([
      {
        status: "modified",
        path: "a.txt",
        oldPath: null,
        added: 1,
        removed: 1,
        binary: false,
        blob: "bbb",
      },
      {
        status: "deleted",
        path: "g.txt",
        oldPath: null,
        added: 0,
        removed: 1,
        binary: false,
        blob: "000",
      },
      {
        status: "renamed",
        path: "q.txt",
        oldPath: "r.txt",
        added: 2,
        removed: 0,
        binary: false,
        blob: "bbb",
      },
      {
        status: "modified",
        path: "img.png",
        oldPath: null,
        added: 0,
        removed: 0,
        binary: true,
        blob: "bbb",
      },
    ])
  })
})
