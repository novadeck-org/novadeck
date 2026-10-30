import { PassThrough } from "node:stream"

import { describe, expect, it } from "../../test"
import { appLog } from "./logs.test-support"
import { eachLine, logRunnerOutput } from "./runner-output"

describe("the runner's output", () => {
  // Feeds `stderr` through to the log as the app does, and waits for it to end.
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

  it("reaches the app's log line by line, redacted, as V8 reports running out of memory", async () => {
    const { logger, lines } = appLog()
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
    const { logger, lines } = appLog()
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
    const { logger, lines } = appLog()
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
