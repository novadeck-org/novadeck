// Hosting terminals: a terminal's run, its screen and input, its events and attachments, each
// with its bounded queue and ack window.
export {
  createTerminal,
  noHold,
  type Attachment,
  type HoldBudget,
  type InputHold,
  type RunSpec,
  type Terminal,
  type TerminalOptions,
} from "./host/terminal.js"
