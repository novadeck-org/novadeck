import { voiceSampleRate } from "@novadeck/protocol"

/** A WAV file holding 16 kHz mono 16-bit little-endian PCM: the 44-byte header, then `pcm`. */
export const wav = (pcm: Uint8Array): Buffer => {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0, "ascii")
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8, "ascii")
  header.writeUInt32LE(16, 16)
  // Linear PCM, one channel.
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(voiceSampleRate, 24)
  header.writeUInt32LE(voiceSampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36, "ascii")
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
