import { describe, expect, it } from "vitest"

import { parseFolders, parseProcesses, sandboxed } from "./darwin.js"

describe("macOS's process listing", () => {
  it("reads each process's pid, parent, group, state, start and command's name", () => {
    const output = [
      "  412     1   412 Ss   Thu Oct  9 11:03:47 2026     /bin/bash",
      "51234   412 51234 T    Fri Oct 10 09:00:01 2026     /Applications/Some App.app/Contents/MacOS/Some App",
      "  777   412   412 Z    Thu Oct  9 11:03:48 2026     (node)",
      "not a process",
    ].join("\n")

    expect(parseProcesses(output)).toEqual([
      {
        pid: 412,
        ppid: 1,
        pgid: 412,
        comm: "bash",
        start: new Date(2026, 9, 9, 11, 3, 47).getTime(),
        stopped: false,
        zombie: false,
      },
      {
        pid: 51234,
        ppid: 412,
        pgid: 51234,
        comm: "Some App",
        start: new Date(2026, 9, 10, 9, 0, 1).getTime(),
        stopped: true,
        zombie: false,
      },
      {
        pid: 777,
        ppid: 412,
        pgid: 412,
        comm: "(node)",
        start: new Date(2026, 9, 9, 11, 3, 48).getTime(),
        stopped: false,
        zombie: true,
      },
    ])
  })

  it("counts a found process's children and its group's, however deep, but never the caller's group", () => {
    const processes = [
      // A program found by its folder, a child it started elsewhere, and that child's own.
      { pid: 10, ppid: 5, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      // A background job of the program's group, its parent gone.
      { pid: 13, ppid: 1, pgid: 10 },
      // The caller's own group, which holds a found process's parent and a stray of its own.
      { pid: 20, ppid: 1, pgid: 20 },
      { pid: 21, ppid: 20, pgid: 20 },
      { pid: 22, ppid: 20, pgid: 20 },
      // Another program altogether.
      { pid: 30, ppid: 1, pgid: 30 },
    ]

    expect([...sandboxed(processes, new Set([10, 21]), 20)].toSorted((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 21,
    ])
  })

  it("reads each process's working folder from lsof's fields", () => {
    const output = ["p412", "fcwd", "n/private/tmp/sandbox test", "p413", "fcwd", "n/"].join("\n")

    expect(parseFolders(output)).toEqual(
      new Map([
        [412, "/private/tmp/sandbox test"],
        [413, "/"],
      ]),
    )
  })
})
