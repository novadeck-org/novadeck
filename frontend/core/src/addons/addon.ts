// What voice input and murmur share about a call their backend refused.

// A call the person made of an addon that its backend refused (the runner answered with an
// error, or could not be reached), kept until the next snapshot. It is the adapter's word,
// apart from `failure`, which is only what the runner says of an install it ran.
export type Refusal = {
  readonly call: "install" | "cancel" | "uninstall" | "set"
  readonly message: string
}

// What a refused call says, with the call named for the addon (`name` as "voice input" or
// "Murmur"): "Couldn't install voice input: …".
export const refusalText = ({ call, message }: Refusal, name: string): string =>
  `Couldn't ${{ install: `install ${name}`, cancel: "cancel the install", uninstall: `uninstall ${name}`, set: `change ${name}` }[call]}: ${message}`
