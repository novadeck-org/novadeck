// A controllable program running inside a real PTY. Base64 JSON lines ensure
// startup input echoed by the OS cannot masquerade as the program's output.
// Raw input keeps the protocol independent of shell syntax and line discipline.
import { appendFileSync } from "node:fs"

// Records what reached the child and what it finished writing, so a test that times
// out can tell lost input from lost output.
const trace = (entry) => {
  if (!process.env.NOVADECK_PTY_TRACE) return
  try {
    appendFileSync(process.env.NOVADECK_PTY_TRACE, `${process.pid} ${entry}\n`)
  } catch {
    // Tracing must never change the child's behaviour.
  }
}
process.stdin.setRawMode(true)
process.stdin.setEncoding("utf8")
const reportInfo = () => {
  process.stdout.write(
    `CHILD_PID=${process.pid};SIZE_${process.stdout.columns}x${process.stdout.rows}_TTY_${process.stdin.isTTY}\r\n`,
  )
}
const reportWhenSized = (command) => {
  if (command.cols === undefined) {
    reportInfo()
    return
  }
  // Node refreshes cached TTY dimensions asynchronously on SIGWINCH. An API
  // resize response does not mean the child has received that notification.
  const check = () => {
    if (process.stdout.columns === command.cols && process.stdout.rows === command.rows) {
      process.stdout.removeListener("resize", check)
      reportInfo()
    }
  }
  process.stdout.on("resize", check)
  check()
}
let input = ""
let noise
const produceNoise = () => {
  if (noise.stopping) {
    noise = undefined
    process.stdout.write("\r\nNOISE_STOPPED\r\n")
    return
  }
  // Schedule only after this chunk drains, leaving stdin responsive and bounding
  // the child-side queue even when the PTY reader is under pressure.
  const checkpoint = noise.started ? "" : "NOISE_STARTED\r\n"
  noise.started = true
  process.stdout.write(checkpoint + ("n".repeat(79) + "\r").repeat(12), () => {
    setImmediate(produceNoise)
  })
}
process.stdin.on("data", (data) => {
  trace(`received ${data.length} chars`)
  input += data
  let newline
  while ((newline = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    const command = JSON.parse(Buffer.from(line, "base64").toString("utf8"))
    trace(`command ${command.type}`)
    if (command.type === "write") {
      process.stdout.write(command.data, () => trace(`wrote ${command.data.length} chars`))
    }
    if (command.type === "info") reportWhenSized(command)
    if (command.type === "burst") process.stdout.write(command.data.repeat(command.count))
    if (command.type === "startNoise" && !noise) {
      noise = { stopping: false, started: false }
      setImmediate(produceNoise)
    }
    if (command.type === "stopNoise" && noise) noise.stopping = true
    if (command.type === "styled") {
      const styledLine = Array.from(
        { length: command.cols },
        (_, x) =>
          `\u001b[38;2;${x % 256};${(x * 3) % 256};${(x * 7) % 256};48;2;${(x * 11) % 256};${(x * 13) % 256};${(x * 17) % 256}mX`,
      ).join("")
      process.stdout.write(
        (styledLine + "\r\n").repeat(command.lines) +
          `\u001b[0m${command.checkpoint ?? "COLORED_READY"}\r\n`,
      )
    }
    if (command.type === "exit") {
      process.stdout.write(command.data ?? "", () => process.exit(command.code ?? 0))
    }
  }
})
process.stdout.write("PTY_READY\r\n")
