import { describe, expect, it } from "vitest"

import { novadeckTool, sleepOnly } from "./tools.js"

describe("a command that only waits", () => {
  it.each([
    "sleep 5",
    "sleep 0.5",
    "sleep 30s",
    "sleep 2m",
    "sleep 1h",
    "sleep 1d",
    "sleep 1 2",
    "  sleep 5  ",
    "sleep 5;",
    "sleep 5; sleep 10",
    "sleep 5 && sleep 10",
    "sleep 5\nsleep 10",
    "sleep 5\r\nsleep 10\r\n",
    "sleep 5 ; sleep 1m && sleep 2",
    "Start-Sleep 5",
    "Start-Sleep -Seconds 5",
    "Start-Sleep -Milliseconds 500",
    "start-sleep -seconds 5",
    "Start-Sleep -s 5",
    "Start-Sleep -Seconds:5",
    "Start-Sleep 5; Start-Sleep -Milliseconds 100",
    "timeout /t 5",
    "timeout /t 5 /nobreak",
    "TIMEOUT /T 5 /NOBREAK",
    "timeout /nobreak /t 5",
    "timeout /t 5 /nobreak && sleep 1",
  ])("is waiting: %j", (command) => {
    expect(sleepOnly(command)).toBe(true)
  })

  it.each([
    "",
    "   ",
    ";",
    "sleep",
    "sleep abc",
    "sleep 5x",
    "sleep -5",
    "sleep 60 && git status",
    "git status && sleep 60",
    "sleep 5; echo done",
    "sleep 5\ngit pull",
    "sleep 5 || true",
    "sleep 5 | cat",
    "sleep 5 &",
    "sleep 5 & sleep 5",
    "sleep 5 > out",
    "sleep 5 $(date)",
    "echo sleep 5",
    "echo 'sleep 5'",
    'echo "a;b"',
    "sleeper 5",
    "timeout 30 cmd",
    "timeout 30 sleep 5",
    "timeout /t",
    "timeout /t x",
    "timeout /t 5 echo hi",
    "Start-Sleep",
    "Start-Sleep -Seconds",
    "Start-Sleep -Seconds 5; Get-Date",
    "Start-Sleep -Foo 5",
    "bash -lc 'sleep 5'",
  ])("is work: %j", (command) => {
    expect(sleepOnly(command)).toBe(false)
  })
})

describe("Novadeck's own tools", () => {
  it("labels a done call as a report, with its subject", () => {
    expect(novadeckTool("done", { subject: "Checkout flow shipped", body: "All green." })).toEqual({
      kind: "agent",
      title: "Reported done",
      detail: "Checkout flow shipped",
    })
  })

  it("keeps the first line of a done report's subject", () => {
    expect(novadeckTool("done", { subject: "Shipped\nand tested", body: "" })?.detail).toBe(
      "Shipped",
    )
  })
})
