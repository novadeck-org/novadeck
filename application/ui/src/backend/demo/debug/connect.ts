import type { SandboxState } from "../../../model/sandbox"
import type { BootRehearsals } from "../../boot-rehearsal"
import type { BackendConnection, ConnectBackend } from "../../port"
import { clearUpdateRaised } from "../../update-raised"
import { keepVariant, rememberVariant, requestedVariant } from "../variants"
import { bootFailures } from "./boot-failures"
import { restoreIconGuides } from "./icon-guides"
import type { DemoPortable } from "./portable"
import { createDebugDemo, type DemoLaunch } from "./with-debug"

const unavailable = (code: string): Error => {
  const failure =
    bootFailures.find((each) => each.code === code) ??
    bootFailures.find((each) => each.kind === "unknown")!
  return Object.assign(new Error(failure.message), { failure })
}

// The content preview's start: a connection that always succeeds, after whatever the
// debug panel rehearsed, into the demo variant it last chose (the address's, at first).
export const connectDemo = (rehearsals: BootRehearsals): ConnectBackend => {
  let variant = requestedVariant()
  keepVariant(variant)
  restoreIconGuides()
  let slowAttach = false
  let sandbox: SandboxState | undefined
  let portable: DemoPortable | undefined
  return async (signal, progress): Promise<BackendConnection> => {
    await rehearsals.beforeConnect(signal, unavailable)
    progress("loading")
    // Each demo boot stands for a launch of the app, retries and variant switches too (the
    // desktop app's retries are not launches): a stale release's notice, shown once per
    // launch, is not held back as already shown by the boot before.
    if (portable?.offer) clearUpdateRaised()
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
      sandbox,
      setSandbox: (next) => {
        sandbox = next
        rehearsals.rehearse({ reboot: true })
      },
      portable,
      setPortable: (next) => {
        portable = next
        rehearsals.rehearse({ reboot: true })
      },
    }
    return { createBackend: () => createDebugDemo(launch), close: () => {} }
  }
}
