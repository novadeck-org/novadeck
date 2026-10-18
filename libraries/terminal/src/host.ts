// Hosting terminals: a terminal's events and attachments, each with its bounded queue and
// ack window.
export {
  createTerminal,
  type Attachment,
  type Emitted,
  type Terminal,
  type TerminalOptions,
  type TerminalView,
} from "./host/terminal.js"
