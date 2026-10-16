import { setTimeout as delay } from "node:timers/promises"

import type { App } from "electron"

// Vendor and device ids Chromium reports for adapters that draw on the processor: Google's
// SwiftShader, Mesa's software rasterizers (llvmpipe, lavapipe) and Microsoft's Basic Render
// Driver (WARP). An adapter that identifies nothing (ids 0 and 0) is not known to be one.
const softwareAdapters: readonly { vendorId: number; deviceId?: number }[] = [
  { vendorId: 0x1a_e0 },
  { vendorId: 0x1_00_05 },
  { vendorId: 0x1_00_04 },
  { vendorId: 0x14_14, deviceId: 0x8c },
]

const isSoftware = (device: unknown): boolean => {
  if (typeof device !== "object" || device === null) return false
  const { vendorId, deviceId } = device as { vendorId?: unknown; deviceId?: unknown }
  if (typeof vendorId !== "number") return false
  return softwareAdapters.some(
    (adapter) =>
      adapter.vendorId === vendorId &&
      (adapter.deviceId === undefined ||
        (typeof deviceId === "number" && adapter.deviceId === deviceId)),
  )
}

/**
 * Whether `app.getGPUInfo("basic")` shows only adapters that draw on the processor, so no
 * graphics hardware murmur could use. Unsure is false: a missing, empty or odd answer, a
 * device it does not know all count as capable, as the install's own check settles the rest.
 */
export const softwareGraphicsOnly = (info: unknown): boolean => {
  const devices = (info as { gpuDevice?: unknown } | null | undefined)?.gpuDevice
  if (!Array.isArray(devices) || devices.length === 0) return false
  return devices.every(isSoftware)
}

/** How long the GPU process may take to answer before the computer is taken to be capable. */
const answerMs = 3000

/**
 * Asks Chromium what this computer draws with; call once the app is ready. Unsure is false.
 * Only on Windows, where it shows a Basic Render Driver (WARP) alone, as in a remote
 * session or a VM without a GPU. Elsewhere it is not asked: on Linux the answer is a plain
 * PCI listing that ignores software rendering, is empty on ARM boards, and where
 * /sys/bus/pci is unreadable (containers, sandboxes) it ends the whole process; macOS
 * always has a GPU. The installs' own checks settle those.
 */
export const detectSoftwareGraphics = async (
  app: Pick<App, "getGPUInfo">,
  machine: { platform: string; arch: string } = process,
): Promise<boolean> => {
  if (machine.platform !== "win32") return false
  const waiting = new AbortController()
  try {
    const info = await Promise.race([
      app.getGPUInfo("basic"),
      delay(answerMs, undefined, { signal: waiting.signal }),
    ])
    return softwareGraphicsOnly(info)
  } catch {
    // Rejected when the GPU is disabled outright (a switch, a blocklist): not a verdict.
    return false
  } finally {
    waiting.abort()
  }
}
