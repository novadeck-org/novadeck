// Hosting terminals: the terminals a host keeps, and each one's run, screen and input, its
// events and attachments, each with its bounded queue and ack window.
export {
  createTerminalHost,
  type Reservation,
  type TerminalHost,
  type TerminalHostOptions,
} from "./host/host.js"
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
