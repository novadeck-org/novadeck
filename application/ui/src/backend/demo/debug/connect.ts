import type { BootRehearsals } from "../../boot-rehearsal"
import type { BackendConnection, ConnectBackend } from "../../port"
import { keepVariant, rememberVariant, requestedVariant } from "../variants"
import { bootFailures } from "./boot-failures"
import { createDebugDemo, type DemoLaunch } from "./with-debug"

const unavailable = (code: string): Error => {
  const failure = bootFailures.find((each) => each.code === code) ?? bootFailures[3]!
  return Object.assign(new Error(failure.message), { failure })
}

// The content preview's start: a connection that always succeeds, after whatever the
// debug panel rehearsed, into the demo variant it last chose (the address's, at first).
export const connectDemo = (rehearsals: BootRehearsals): ConnectBackend => {
  let variant = requestedVariant()
  keepVariant(variant)
  let slowAttach = false
  return async (signal, progress): Promise<BackendConnection> => {
    await rehearsals.beforeConnect(signal, unavailable)
    progress("loading")
    // An abandoned attempt leaves the arming for the next.
    const slow = slowAttach && !signal.aborted
    if (slow) slowAttach = false
    const launch: DemoLaunch = {
      rehearsals,
      variant,
      slowAttach: slow,
      switchVariant: (next) => {
        variant = next
        rememberVariant(next)
        rehearsals.rehearse({ reboot: true })
      },
      armSlowAttach: () => {
        slowAttach = true
        rehearsals.rehearse({ reboot: true })
      },
    }
    return { createBackend: () => createDebugDemo(launch), close: () => {} }
  }
}
