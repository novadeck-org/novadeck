// Murmur runs on a GPU and nothing else. llama-server's `--list-devices` names the devices
// and, in the engine we build, their kind; this reads the list and orders what to try.

export type DeviceKind = "cpu" | "gpu" | "igpu" | "accel"

export type Device = {
  /** What `--device` takes, such as "Vulkan0". Indexes differ between machines: never assume one. */
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  readonly totalMiB: number
  readonly freeMiB: number
}

const line = /^\s*([^\s:]+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)\s*\[(cpu|gpu|igpu|accel)\]\s*$/

/** The devices `--list-devices` printed; lines that aren't devices, or have no kind, are skipped. */
export const parseDevices = (output: string): Device[] => {
  const devices: Device[] = []
  for (const text of output.split(/\r?\n/)) {
    const match = line.exec(text)
    if (match === null) continue
    devices.push({
      id: match[1]!,
      name: match[2]!,
      kind: match[5] as DeviceKind,
      totalMiB: Number(match[3]),
      freeMiB: Number(match[4]),
    })
  }
  return devices
}

/**
 * The devices to try, in order: integrated GPUs first, as they share the machine's memory
 * and leave a dedicated card to the person's own work, then dedicated GPUs. The CPU and
 * accelerators are never candidates.
 */
export const candidates = (devices: readonly Device[]): Device[] => [
  ...devices.filter((device) => device.kind === "igpu"),
  ...devices.filter((device) => device.kind === "gpu"),
]
