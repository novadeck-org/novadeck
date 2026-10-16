// How the addons' sizes and install steps read, shared by voice input and murmur.

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte

// A download size in whole megabytes, or gigabytes with a decimal from one up. Anything
// received reads as at least a megabyte; only nothing at all reads as none.
export const formatSize = (bytes: number): string =>
  bytes >= gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : `${bytes <= 0 ? 0 : Math.max(1, Math.round(bytes / megabyte))} MB`

export type InstallStep = "engine" | "model" | "check"

// What a step of an install is called. The check's name is the addon's own, as murmur's
// checks "this computer".
export const stepLabel = (step: InstallStep, checking = "Checking"): string =>
  step === "engine" ? "Downloading engine" : step === "model" ? "Downloading model" : checking
