// A thinking block's signature as Claude Code writes one (see narration.ts): its kind in field 8 of
// the message in field 1 of field 2, the rest of its bytes opaque (zeroed here).
const varint = (value: number): number[] =>
  value < 0x80 ? [value] : [(value & 0x7f) | 0x80, ...varint(value >> 7)]

export const signature = (kind: string): string => {
  const name = [...Buffer.from(kind)]
  const inner = [0x08, 0x13, 0x18, 0x02, 0x38, 0x01, 0x42, name.length, ...name]
  const message = [
    0x0a,
    ...varint(inner.length),
    ...inner,
    0x12,
    0x0c,
    ...Array.from({ length: 12 }, () => 0),
  ]
  return Buffer.from([0x08, 0x04, 0x12, ...varint(message.length), ...message]).toString("base64")
}
