import { ptyChild, ptyChildEnv } from "@novadeck/terminal/testing"

/** A terminal manager's options that run the terminal library's test child as its shell. */
export const ptyOptions = {
  shell: process.execPath,
  shellArgs: [ptyChild],
  env: ptyChildEnv,
}
