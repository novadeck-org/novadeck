import type { BackendConnection, ConnectBackend } from "../../port"
import { visitorDemo } from "./index"

// The visitor build's start: a connection that always succeeds, with nothing to reach.
export const connectVisitor: ConnectBackend = async (
  _signal,
  progress,
): Promise<BackendConnection> => {
  progress("loading")
  return { createBackend: visitorDemo, close: () => {} }
}
