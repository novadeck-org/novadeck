import { concurrently } from "concurrently"

import { devToken, devWebCommands } from "./web.ts"

// `pnpm dev:web`: a runner and the browser UI connected to it with a one-off token.
export const main = async (): Promise<void> => {
  const { result } = concurrently([...devWebCommands(devToken())], {
    killOthersOn: ["failure"],
    prefixColors: ["blue", "magenta"],
  })
  await result
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // concurrently has already reported which command failed.
    process.exitCode = 1
  }
}
