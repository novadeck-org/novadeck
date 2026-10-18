// Hosting terminals: a terminal's events and attachments, each with its bounded queue and
// ack window.
export {
  createTerminal,
  type Attachment,
  type RunSpec,
  type Terminal,
  type TerminalOptions,
} from "./host/terminal.js"
