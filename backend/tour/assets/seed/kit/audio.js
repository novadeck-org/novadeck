// audio.js — sound effects and generative music, all synthesized with WebAudio. No files.
//   const audio = createAudio()   // starts on the first click or key
//   audio.play("shoot"); audio.music("synthwave", { seed: 3 }); audio.intensity = 0.8
// Graph: sounds and music -> master -> compressor -> tanh limiter -> speakers, so nothing clips.

const warn = (...a) => console.warn("[kit/audio]", ...a)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const mtof = (m) => 440 * 2 ** ((m - 69) / 12)
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const SOUNDS = ["shoot", "laser", "hit", "hurt", "explode", "jump", "land", "pickup", "coin", "powerup", "heal", "magic", "step", "dash", "click", "select", "error", "alarm", "win", "lose", "levelup"]
export const MOODS = ["action", "calm", "spooky", "heroic", "chiptune", "synthwave", "ambient"]

// ---------- primitives ----------
const gain = (c, v = 1) => { const g = c.createGain(); g.gain.value = v; return g }
const pulses = new WeakMap()
function setWave(c, osc, type) {
  const m = /^pulse(\d+)$/.exec(type)
  if (!m) { osc.type = type; return }
  const duty = +m[1] / 100
  let cache = pulses.get(c); if (!cache) pulses.set(c, (cache = {}))
  if (!cache[type]) {
    const re = new Float32Array(40), im = new Float32Array(40)
    for (let n = 1; n < 40; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty)
    cache[type] = c.createPeriodicWave(re, im)
  }
  osc.setPeriodicWave(cache[type])
}
// a filter that may sweep: spec is Hz or [from, to]
function filt(c, type, spec, q, t, dur) {
  const f = c.createBiquadFilter()
  f.type = type; f.Q.value = q ?? 0.7
  const [a, b] = Array.isArray(spec) ? spec : [spec, spec]
  f.frequency.setValueAtTime(clamp(a, 20, 18000), t)
  if (b !== a) f.frequency.exponentialRampToValueAtTime(clamp(b, 20, 18000), t + dur)
  return f
}
function chain(c, src, o, t, dur) {
  let n = src
  for (const [k, type] of [["lp", "lowpass"], ["hp", "highpass"], ["bp", "bandpass"]]) {
    if (o[k]) { const f = filt(c, type, o[k], o.q, t, dur); n.connect(f); n = f }
  }
  return n
}
function pluckEnv(g, t, peak, a, d) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a)
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d)
}
// one oscillator: o = { type, f0, f1, dur, vol, a, lp|hp|bp, q, det, vib:[hz,cents] }
function tone(c, dest, t, o) {
  const dur = o.dur ?? 0.2, a = o.a ?? 0.004
  const osc = c.createOscillator(); setWave(c, osc, o.type || "sine")
  osc.frequency.setValueAtTime(o.f0, t)
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur * (o.sweep ?? 1))
  if (o.det) osc.detune.value = o.det
  if (o.vib) {
    const l = c.createOscillator(), lg = gain(c, o.vib[1]); l.frequency.value = o.vib[0]
    l.connect(lg).connect(osc.detune); l.start(t); l.stop(t + dur + a + 0.1)
  }
  const g = c.createGain(); pluckEnv(g, t, o.vol ?? 0.3, a, dur)
  chain(c, osc, o, t, dur).connect(g).connect(dest)
  osc.start(t); osc.stop(t + a + dur + 0.05)
}
let noiseBuf = null
function noise(c, dest, t, o) {
  if (!noiseBuf || noiseBuf.ctx !== c) {
    const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noiseBuf = { ctx: c, buf: b }
  }
  const dur = o.dur ?? 0.2, a = o.a ?? 0.003
  const s = c.createBufferSource(); s.buffer = noiseBuf.buf; s.loop = true
  const g = c.createGain(); pluckEnv(g, t, o.vol ?? 0.3, a, dur)
  chain(c, s, o, t, dur).connect(g).connect(dest)
  s.start(t, Math.random() * 1.5); s.stop(t + a + dur + 0.05)
}

// ---------- sound effects ----------
// Each gets x: { tone(at, opts), noise(at, opts), r(lo, hi) } with the pitch variation applied.
const PENT = [0, 2, 4, 7, 9]
const SFX = {
  shoot: (x) => {
    x.noise(0, { dur: 0.13, vol: 0.45, bp: [4500, 700], q: 1.1 })
    x.tone(0, { type: "sawtooth", f0: 1100, f1: 140, dur: 0.14, vol: 0.3, lp: [6000, 700] })
    x.tone(0, { type: "square", f0: 640, f1: 90, dur: 0.09, vol: 0.14 })
    x.tone(0, { f0: 190, f1: 50, dur: 0.13, vol: 0.5 })
  },
  laser: (x) => {
    x.tone(0, { type: "sawtooth", f0: 2100, f1: 220, dur: 0.24, vol: 0.28, lp: [7000, 900], q: 3, vib: [38, 40] })
    x.tone(0, { type: "sine", f0: 2800, f1: 500, dur: 0.18, vol: 0.2 })
    x.noise(0, { dur: 0.05, vol: 0.2, hp: 5000 })
  },
  hit: (x) => {
    x.noise(0, { dur: 0.11, vol: 0.55, lp: [2800, 300] })
    x.tone(0, { type: "triangle", f0: 240, f1: 70, dur: 0.12, vol: 0.55 })
    x.tone(0, { type: "square", f0: 900, f1: 300, dur: 0.03, vol: 0.2 })
  },
  hurt: (x) => {
    x.tone(0, { type: "sawtooth", f0: 340, f1: 90, dur: 0.3, vol: 0.32, lp: [2600, 250], q: 2 })
    x.tone(0, { type: "square", f0: 330, f1: 84, dur: 0.28, vol: 0.18, det: 25, lp: 1500 })
    x.noise(0, { dur: 0.1, vol: 0.35, lp: [3500, 500] })
  },
  explode: (x) => {
    x.noise(0, { dur: 1.0, vol: 0.9, lp: [4200, 90], a: 0.005 })
    x.noise(0, { dur: 0.25, vol: 0.5, hp: 3000 })
    x.tone(0, { f0: 130, f1: 28, dur: 0.9, vol: 0.9, sweep: 0.8 })
    x.tone(0, { type: "sawtooth", f0: 90, f1: 35, dur: 0.6, vol: 0.25, lp: 400 })
    for (let i = 0; i < 6; i++) x.noise(0.12 + i * 0.07 + x.r(0, 0.05), { dur: 0.07, vol: 0.2, bp: x.r(900, 3000), q: 1.5 })
  },
  jump: (x) => {
    x.tone(0, { type: "square", f0: 260, f1: 680, dur: 0.17, vol: 0.18, lp: 3500 })
    x.tone(0, { type: "triangle", f0: 520, f1: 1360, dur: 0.14, vol: 0.2 })
    x.noise(0, { dur: 0.06, vol: 0.12, hp: 3000 })
  },
  land: (x) => {
    x.tone(0, { f0: 150, f1: 48, dur: 0.14, vol: 0.6 })
    x.noise(0, { dur: 0.09, vol: 0.35, lp: [900, 250] })
  },
  pickup: (x) => {
    x.tone(0, { type: "triangle", f0: 660, dur: 0.1, vol: 0.28 })
    x.tone(0.07, { type: "triangle", f0: 990, dur: 0.22, vol: 0.28 })
    x.tone(0.07, { type: "sine", f0: 1980, dur: 0.3, vol: 0.12 })
    x.noise(0.07, { dur: 0.12, vol: 0.06, hp: 8000 })
  },
  coin: (x) => {
    x.tone(0, { type: "square", f0: 988, dur: 0.07, vol: 0.16, lp: 5000 })
    x.tone(0.065, { type: "square", f0: 1319, dur: 0.32, vol: 0.16, lp: 5000 })
    x.tone(0.065, { f0: 2637, dur: 0.4, vol: 0.12 })
  },
  powerup: (x) => {
    const notes = [0, 4, 7, 12, 16, 19, 24]
    notes.forEach((n, i) => {
      x.tone(i * 0.065, { type: "sawtooth", f0: 330 * 2 ** (n / 12), dur: 0.16, vol: 0.2, lp: [5000, 1500], det: 6 })
      x.tone(i * 0.065, { type: "square", f0: 660 * 2 ** (n / 12), dur: 0.12, vol: 0.08 })
    })
    x.tone(0.45, { type: "sawtooth", f0: 1318, dur: 0.5, vol: 0.18, lp: 4000, vib: [7, 15] })
  },
  heal: (x) => {
    ;[0, 4, 7, 12].forEach((n, i) => {
      x.tone(i * 0.09, { f0: 523 * 2 ** (n / 12), dur: 0.5, vol: 0.22, a: 0.02 })
      x.tone(i * 0.09, { type: "triangle", f0: 1046 * 2 ** (n / 12), dur: 0.35, vol: 0.07, a: 0.02 })
    })
    x.noise(0, { dur: 0.5, vol: 0.05, hp: 7000, a: 0.2 })
  },
  magic: (x) => {
    const base = 880 * 2 ** (PENT[Math.floor(x.r(0, 5))] / 12)
    x.tone(0, { f0: base * 0.5, f1: base * 2, dur: 0.5, vol: 0.18, a: 0.03, vib: [11, 30] })
    for (let i = 0; i < 7; i++) {
      x.tone(i * 0.055, { f0: base * 2 ** (PENT[Math.floor(x.r(0, 5))] / 12 + (i % 2)), dur: 0.2, vol: 0.1, det: x.r(-10, 10) })
    }
    x.noise(0, { dur: 0.6, vol: 0.07, bp: [6000, 11000], q: 2, a: 0.15 })
  },
  step: (x) => {
    x.noise(0, { dur: 0.05, vol: 0.28, lp: x.r(500, 1100), a: 0.002 })
    x.tone(0, { f0: x.r(80, 110), f1: 50, dur: 0.06, vol: 0.3 })
  },
  dash: (x) => {
    x.noise(0, { dur: 0.25, vol: 0.5, bp: [350, 4200], q: 0.9, a: 0.05 })
    x.tone(0, { type: "sawtooth", f0: 180, f1: 700, dur: 0.2, vol: 0.12, lp: 2000 })
  },
  click: (x) => {
    x.tone(0, { type: "triangle", f0: 1800, f1: 1200, dur: 0.03, vol: 0.25 })
    x.noise(0, { dur: 0.015, vol: 0.18, hp: 4000 })
  },
  select: (x) => {
    x.tone(0, { type: "triangle", f0: 660, dur: 0.08, vol: 0.25 })
    x.tone(0.07, { type: "triangle", f0: 990, dur: 0.16, vol: 0.25 })
    x.tone(0.07, { f0: 1980, dur: 0.12, vol: 0.06 })
  },
  error: (x) => {
    for (let i = 0; i < 2; i++) {
      x.tone(i * 0.14, { type: "square", f0: 160, f1: 140, dur: 0.11, vol: 0.2, lp: 1200 })
      x.tone(i * 0.14, { type: "sawtooth", f0: 168, f1: 148, dur: 0.11, vol: 0.14, lp: 1000 })
    }
  },
  alarm: (x) => {
    for (let i = 0; i < 6; i++) {
      x.tone(i * 0.15, { type: "square", f0: i % 2 ? 660 : 880, dur: 0.13, vol: 0.18, lp: 2500, a: 0.005 })
      x.tone(i * 0.15, { type: "sawtooth", f0: i % 2 ? 663 : 884, dur: 0.13, vol: 0.1, lp: 2000 })
    }
  },
  win: (x) => {
    const seq = [[0, 0], [0.13, 4], [0.26, 7], [0.4, 12]]
    for (const [t, n] of seq) {
      x.tone(t, { type: "sawtooth", f0: 262 * 2 ** (n / 12), dur: 0.2, vol: 0.2, lp: [4000, 1200], det: 8 })
      x.tone(t, { type: "square", f0: 524 * 2 ** (n / 12), dur: 0.16, vol: 0.07 })
    }
    for (const n of [0, 4, 7, 12, 16]) x.tone(0.55, { type: "sawtooth", f0: 262 * 2 ** (n / 12), dur: 1.0, vol: 0.12, a: 0.01, lp: [3500, 900], det: n ? 6 : -6 })
    x.tone(0.55, { f0: 2093, dur: 0.9, vol: 0.06 })
  },
  lose: (x) => {
    ;[[0, 0], [0.22, -1], [0.44, -3], [0.66, -7]].forEach(([t, n], i) => {
      x.tone(t, { type: "sawtooth", f0: 392 * 2 ** (n / 12), f1: i === 3 ? 392 * 2 ** (n / 12) * 0.55 : 0, dur: i === 3 ? 0.9 : 0.25, vol: 0.2, lp: [2500, 500], det: 9, vib: [5, 12] })
      x.tone(t, { type: "triangle", f0: 196 * 2 ** (n / 12), dur: i === 3 ? 0.9 : 0.25, vol: 0.2 })
    })
  },
  levelup: (x) => {
    const n = [0, 4, 7, 12, 16, 19, 24, 28]
    n.forEach((s, i) => {
      x.tone(i * 0.07, { type: "square", f0: 392 * 2 ** (s / 12), dur: 0.13, vol: 0.13, lp: 5000 })
      x.tone(i * 0.07, { type: "triangle", f0: 784 * 2 ** (s / 12), dur: 0.2, vol: 0.14 })
    })
    for (const s of [24, 28, 31]) x.tone(0.56, { f0: 392 * 2 ** (s / 12), dur: 0.7, vol: 0.1, a: 0.01 })
    x.noise(0.5, { dur: 0.6, vol: 0.06, hp: 8000 })
  },
}
// how much reverb each sound sends
const WET = { explode: 0.3, magic: 0.45, heal: 0.4, win: 0.35, lose: 0.3, levelup: 0.3, powerup: 0.15, select: 0.1, alarm: 0.1 }

// ---------- music: voices ----------
// A voice is up to three oscillators { t: wave, d: cents, m: frequency multiplier, g: level }
// through a lowpass that may sweep, with a plucked (decay) or held (sustain + release) envelope.
const VOICES = {
  sawLead: { osc: [{ t: "sawtooth", d: -8 }, { t: "sawtooth", d: 8 }], lp: [5200, 1400], q: 1.5, a: 0.01, r: 0.12, g: 0.15 },
  synthLead: { osc: [{ t: "sawtooth", d: -10 }, { t: "square", d: 10, g: 0.7 }], lp: [4200, 2200], q: 3, a: 0.02, r: 0.25, g: 0.14 },
  pulse: { osc: [{ t: "pulse25" }], a: 0.004, r: 0.05, g: 0.1 },
  pulse50: { osc: [{ t: "pulse50" }], a: 0.004, r: 0.05, g: 0.09 },
  bell: { osc: [{ t: "sine" }, { t: "sine", m: 2.01, g: 0.35 }, { t: "triangle", m: 4.2, g: 0.1 }], a: 0.004, decay: 1, g: 0.2 },
  keys: { osc: [{ t: "triangle" }, { t: "sine", m: 2, g: 0.3 }], lp: [4000, 900], a: 0.005, decay: 1, g: 0.2 },
  pad: { osc: [{ t: "sawtooth", d: -12 }, { t: "sawtooth", d: 0 }, { t: "sawtooth", d: 12 }], lp: [500, 1500], q: 0.6, a: 0.5, r: 0.8, g: 0.045 },
  softPad: { osc: [{ t: "sine" }, { t: "triangle", d: 6, g: 0.5 }], a: 1.2, r: 1.5, g: 0.035 },
  dark: { osc: [{ t: "sawtooth", d: -15 }, { t: "square", d: 15, g: 0.6 }], lp: [350, 900], q: 4, a: 1.5, r: 1.5, g: 0.03 },
  strings: { osc: [{ t: "sawtooth", d: -9 }, { t: "sawtooth", d: 9 }], lp: [1200, 2400], a: 0.35, r: 0.6, g: 0.06 },
  brass: { osc: [{ t: "sawtooth", d: -6 }, { t: "sawtooth", d: 6 }], lp: [700, 3200], q: 1, a: 0.07, r: 0.15, g: 0.14 },
  bassSaw: { osc: [{ t: "sawtooth" }, { t: "sine", m: 0.5, g: 0.9 }], lp: [1800, 250], q: 4, a: 0.005, decay: 1, g: 0.3 },
  bassSub: { osc: [{ t: "sine" }, { t: "triangle", m: 2, g: 0.15 }], a: 0.03, r: 0.3, g: 0.2 },
  bassTri: { osc: [{ t: "triangle" }], a: 0.004, decay: 1, g: 0.3 },
  pluck: { osc: [{ t: "sawtooth" }, { t: "square", d: 7, g: 0.5 }], lp: [4500, 600], q: 2, a: 0.003, decay: 1, g: 0.12 },
}
function voice(c, dest, t, midi, dur, name, vel = 1) {
  const p = VOICES[name], f = mtof(midi), a = p.a, r = p.r ?? 0.1
  const g = c.createGain(), peak = Math.max(0.0003, vel * p.g)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + a)
  let end
  if (p.decay) { end = t + a + dur * p.decay; g.gain.exponentialRampToValueAtTime(0.0001, end) }
  else { g.gain.setValueAtTime(peak, t + Math.max(a, dur)); end = t + Math.max(a, dur) + r; g.gain.exponentialRampToValueAtTime(0.0001, end) }
  let out = g
  if (p.lp) { const fl = filt(c, "lowpass", p.lp, p.q, t, Math.max(0.1, end - t)); fl.connect(g); out = fl }
  for (const o of p.osc) {
    const osc = c.createOscillator(); setWave(c, osc, o.t)
    osc.frequency.value = f * (o.m ?? 1); osc.detune.value = o.d ?? 0
    if (o.g != null && o.g !== 1) { const og = gain(c, o.g); osc.connect(og).connect(out) } else osc.connect(out)
    osc.start(t); osc.stop(end + 0.05)
  }
  g.connect(dest)
}

// ---------- music: drums ----------
function kick(c, d, t, v = 1, soft = false) {
  tone(c, d, t, { f0: soft ? 110 : 160, f1: 42, dur: soft ? 0.22 : 0.16, sweep: 0.5, vol: 0.9 * v, a: 0.002 })
  if (!soft) noise(c, d, t, { dur: 0.012, vol: 0.2 * v, hp: 2000 })
}
function snare(c, d, t, v = 1) {
  noise(c, d, t, { dur: 0.16, vol: 0.4 * v, hp: 1500 })
  tone(c, d, t, { type: "triangle", f0: 220, f1: 130, dur: 0.1, vol: 0.4 * v })
}
function clap(c, d, t, v = 1) {
  for (let i = 0; i < 3; i++) noise(c, d, t + i * 0.011, { dur: 0.05, vol: 0.28 * v, bp: 1400, q: 1.2 })
  noise(c, d, t + 0.033, { dur: 0.22, vol: 0.25 * v, bp: 1300, q: 0.9 })
}
const hat = (c, d, t, v = 1, open = false) => noise(c, d, t, { dur: open ? 0.22 : 0.04, vol: 0.16 * v, hp: 7500 })
const tom = (c, d, t, f, v = 1) => tone(c, d, t, { f0: f * 1.5, f1: f, dur: 0.22, vol: 0.6 * v })
const crash = (c, d, t) => noise(c, d, t, { dur: 1.6, vol: 0.2, hp: 5500, a: 0.004 })

// ---------- music: moods ----------
// scale: semitones; roots: possible tonic MIDI notes; progs: chord degrees (0 = I); hr: bars per
// chord; rhythms: lead note positions in a 16-step bar; drums: pattern names; arpAt: intensity
// at which arpeggios join.
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], mixo: [0, 2, 4, 5, 7, 9, 10], harm: [0, 2, 3, 5, 7, 8, 11],
}
const MOOD = {
  action: { bpm: [138, 150], scale: "minor", roots: [45, 47, 50], progs: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 0, 5, 6]], hr: 1, lead: "sawLead", pad: "strings", bass: "drive", bassV: "bassSaw", drums: "drive", arp: "pluck", arpAt: 0.45, delay: 0.18, rev: 0.12, range: [3, 12], rhythms: [[0, 3, 6, 8, 10, 12, 14], [0, 2, 4, 6, 8, 11, 14], [0, 3, 4, 8, 11, 12]], crash: 1, duck: 0.15 },
  calm: { bpm: [70, 82], scale: "major", roots: [48, 50, 53], progs: [[0, 5, 3, 4], [0, 3, 5, 4], [0, 2, 3, 4]], hr: 2, lead: "bell", pad: "softPad", bass: "long", bassV: "bassSub", drums: null, arp: "keys", arpAt: 0, delay: 0.25, rev: 0.4, range: [4, 11], rhythms: [[0, 6, 10], [0, 8], [0, 4, 8, 12], [2, 6, 12]], duck: 0 },
  spooky: { bpm: [62, 74], scale: "phrygian", roots: [43, 45, 46], progs: [[0, 1, 0, 6], [0, 5, 1, 0], [0, 1, 5, 4]], hr: 2, lead: "bell", pad: "dark", bass: "drone", bassV: "bassSub", drums: "heart", arp: "bell", arpAt: 0.55, delay: 0.3, rev: 0.55, range: [4, 12], rhythms: [[0, 7, 13], [0, 10], [3, 11]], creak: 1, duck: 0 },
  heroic: { bpm: [104, 116], scale: "major", roots: [50, 52, 53], progs: [[0, 4, 5, 3], [0, 3, 4, 0], [0, 5, 3, 4]], hr: 1, lead: "brass", pad: "strings", bass: "march", bassV: "bassSaw", drums: "march", arp: "pluck", arpAt: 0.7, delay: 0.1, rev: 0.3, range: [4, 12], rhythms: [[0, 3, 4, 8, 11, 12], [0, 4, 6, 8, 12, 14], [0, 2, 4, 8, 10, 12]], crash: 1, duck: 0.1 },
  chiptune: { bpm: [146, 160], scale: "major", roots: [48, 50, 52], progs: [[0, 5, 3, 4], [0, 4, 5, 3], [5, 3, 0, 4]], hr: 1, lead: "pulse", pad: null, bass: "chip", bassV: "bassTri", drums: "chip", arp: "pulse50", arpAt: 0, delay: 0, rev: 0, range: [4, 13], rhythms: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 6, 8, 11, 14], [0, 2, 3, 6, 8, 10, 11, 14]], duck: 0, flat: 1 },
  synthwave: { bpm: [100, 112], scale: "minor", roots: [45, 40, 43], progs: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 2, 5, 3], [0, 5, 6, 4]], hr: 1, lead: "synthLead", pad: "pad", bass: "pulse", bassV: "bassSaw", drums: "floor", arp: "pluck", arpAt: 0.35, delay: 0.3, rev: 0.25, range: [3, 12], rhythms: [[0, 3, 6, 10, 12], [0, 2, 4, 8, 10, 14], [0, 6, 8, 11]], crash: 1, duck: 0.65 },
  ambient: { bpm: [56, 66], scale: "lydian", roots: [50, 53, 55], progs: [[0, 4, 5, 3], [0, 1, 4, 0], [0, 5, 1, 4]], hr: 2, lead: "bell", pad: "softPad", bass: "drone", bassV: "bassSub", drums: null, arp: "bell", arpAt: 0.5, delay: 0.35, rev: 0.7, range: [5, 13], rhythms: [[0, 10], [4], [0, 6, 12], [8]], duck: 0 },
}
const DRUMS = {
  drive: { kick: "x.....x.x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  floor: { kick: "x...x...x...x...", clap: "....x.......x...", hat: "..x...x...x...x." },
  march: { kick: "x...x...x...x...", snare: "....x..x....x.x.", hat: "" },
  chip: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  heart: { kick: "x.x.............", snare: "", hat: "" },
}
const BASS = {
  drive: [[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 12, 1], [8, 0, 2], [10, 0, 2], [12, 7, 2], [14, 12, 1]],
  pulse: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14].map((s) => [s, s === 3 || s === 11 ? 12 : 0, 2]),
  march: [[0, 0, 3], [4, 0, 3], [8, 7, 3], [12, 0, 3]],
  chip: [[0, 0, 3], [3, 0, 1], [4, 12, 3], [8, 7, 3], [11, 7, 1], [12, 12, 3]],
  long: [[0, 0, 15]],
  drone: [[0, 0, 16]],
}

const sd = (scale, deg) => scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7)

function buildSong(mood, seed, tempo) {
  const M = MOOD[mood], rnd = mulberry32(seed), pick = (a) => a[Math.floor(rnd() * a.length)]
  const scale = SCALES[M.scale], root = pick(M.roots), prog = pick(M.progs)
  const bpm = tempo ?? Math.round(M.bpm[0] + rnd() * (M.bpm[1] - M.bpm[0]))
  const chordDeg = (bar) => {
    if (M.hr === 1 && bar === 7) return pick([4, 4, 6]) // turnaround
    return prog[Math.floor(bar / M.hr) % prog.length]
  }
  const chords = []
  for (let b = 0; b < 8; b++) {
    const r = chordDeg(b), degs = [r, r + 2, r + 4]
    if (mood === "synthwave" || mood === "spooky") degs.push(r + 6)
    chords.push({ r, degs, pcs: degs.map((d) => sd(scale, d)) })
  }
  // lead melody: a motif (rhythm + intervals) answered over the chords, then a cadence
  const lo = M.range[0], hi = M.range[1], near = (deg, tones) => {
    let best = deg, bd = 99
    for (let d = deg - 3; d <= deg + 3; d++) if (tones.some((t) => (((d - t) % 7) + 7) % 7 === 0) && Math.abs(d - deg) < bd) { best = d; bd = Math.abs(d - deg) }
    return best
  }
  const melody = Array.from({ length: 8 }, () => [])
  for (let half = 0; half < 2; half++) {
    const rhy = pick(M.rhythms), ivs = rhy.map(() => pick([-2, -1, -1, 0, 1, 1, 2, 3, -3]))
    let p = lo + 2 + Math.floor(rnd() * 3)
    for (let b = 0; b < 4; b++) {
      const bar = half * 4 + b, tones = chords[bar].degs, notes = []
      const steps = b === 3 ? pick([[0, 6, 8], [0, 8], [0, 4, 8, 12]]) : rhy
      steps.forEach((st, i) => {
        p += i === 0 ? 0 : b === 3 ? pick([-2, -1, -1, 1]) : ivs[i] + (b === 2 && i >= steps.length - 2 ? 1 : 0)
        if (i === 0 || st === 8) p = near(p, tones)
        p = clamp(p, lo, hi)
        let deg = p
        if (b === 3 && i === steps.length - 1) deg = half === 1 ? near(p, [0]) : near(p, [chords[bar].r + 2, chords[bar].r + 4])
        const nxt = steps[i + 1] ?? 16
        notes.push({ st, deg, len: Math.min(nxt - st, 8) })
      })
      melody[bar] = notes
    }
  }
  const arp = pick(mood === "chiptune" ? [[0, 1, 2, 1], [0, 2, 1, 2], [2, 1, 0, 1]] : [[0, 1, 2, 3, 2, 1, 0, 1], [0, 2, 1, 2, 3, 2, 1, 2], [0, 1, 2, 1]])
  const thin = Array.from({ length: 128 }, rnd) // which lead notes drop out at low intensity
  const chance = Array.from({ length: 128 }, rnd) // sparse events
  return { M, mood, scale, root, bpm, chords, melody, arp, thin, chance }
}

// ---------- the audio object ----------
export function createAudio(options = {}) {
  let ctx = null, master, sfxBus, musicBus, reverbIn
  let muted = false, intensity = 0.4, volume = 0.85, track = null, pending = null
  const lastPlay = new Map(), tracks = new Set()

  function setup(c) {
    ctx = c
    master = gain(c, muted ? 0 : volume)
    const comp = c.createDynamicsCompressor()
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.2
    const lim = c.createWaveShaper(), curve = new Float32Array(2048)
    for (let i = 0; i < 2048; i++) curve[i] = Math.tanh(((i / 2047) * 2 - 1) * 1.3) / Math.tanh(1.3) * 0.94
    lim.curve = curve; lim.oversample = "2x"
    master.connect(comp); comp.connect(lim); lim.connect(c.destination)
    sfxBus = gain(c, 0.9); musicBus = gain(c, 0.5)
    sfxBus.connect(master); musicBus.connect(master)
    // reverb: generated impulse response, a dark tail
    const len = Math.floor(c.sampleRate * 2.2), ir = c.createBuffer(2, len, c.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let lp = 0
      for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * (0.9 - 0.8 * (i / len)); d[i] = lp * (1 - i / len) ** 2.5 * 1.5 }
    }
    const conv = c.createConvolver(); conv.buffer = ir
    reverbIn = gain(c, 1)
    const wet = gain(c, 0.7)
    reverbIn.connect(conv); conv.connect(wet); wet.connect(master)
    if (pending) { const p = pending; pending = null; music(p.mood, p.opts) }
  }

  function start() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume?.().catch(() => {}); return }
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      const c = new AC(); setup(c)
      c.resume?.().catch(() => {})
    } catch (e) { warn("audio unavailable:", e?.message) }
  }
  if (options.context) setup(options.context)
  else if (typeof window !== "undefined") {
    for (const ev of ["pointerdown", "keydown", "touchend", "click"]) window.addEventListener(ev, start, { capture: true, passive: true })
  }

  function play(name = "click", o = {}) {
    if (typeof name !== "string" || !SFX[name]) { warn(`unknown sound "${name}" (use ${SOUNDS.join(", ")}); playing "click".`); name = "click" }
    if (!ctx || typeof o !== "object" || !o) return
    const now = ctx.currentTime
    if (now - (lastPlay.get(name) ?? -1) < 0.025) return // identical sounds in the same instant would only add loudness
    lastPlay.set(name, now)
    const pitch = (+o.pitch || 1) * (1 + (Math.random() - 0.5) * 0.08)
    const vol = clamp(o.volume ?? 1, 0, 2)
    const out = gain(ctx, vol); out.connect(sfxBus)
    if (WET[name]) { const s = gain(ctx, WET[name]); out.connect(s); s.connect(reverbIn) }
    const t0 = now + 0.005
    const x = {
      tone: (at, op) => tone(ctx, out, t0 + at, { ...op, f0: op.f0 * pitch, f1: op.f1 ? op.f1 * pitch : op.f1, dur: (op.dur ?? 0.2) / Math.sqrt(pitch) }),
      noise: (at, op) => noise(ctx, out, t0 + at, op),
      r: (a, b) => a + Math.random() * (b - a),
    }
    try { SFX[name](x) } catch (e) { warn("sound failed:", e?.message) }
  }

  function stopTrack(tr, fade = 0.7) {
    if (!tr) return
    clearInterval(tr.timer); tr.stopped = true; tracks.delete(tr)
    const t = ctx.currentTime
    tr.out.gain.cancelScheduledValues(t); tr.out.gain.setValueAtTime(tr.out.gain.value, t); tr.out.gain.linearRampToValueAtTime(0, t + fade)
    setTimeout(() => { try { tr.out.disconnect() } catch {} }, fade * 1000 + 300)
  }

  function music(mood = "action", o = {}) {
    if (mood == null || mood === false) { pending = null; stopTrack(track); track = null; return }
    if (typeof mood !== "string" || !MOOD[mood]) { warn(`unknown mood "${mood}" (use ${MOODS.join(", ")}); using "action".`); mood = "action" }
    if (!ctx) { pending = { mood, opts: o }; return }
    o = o && typeof o === "object" ? o : {}
    stopTrack(track); track = null
    const song = buildSong(mood, Number.isFinite(+o.seed) ? +o.seed : 1, Number.isFinite(+o.tempo) ? clamp(+o.tempo, 40, 220) : undefined)
    const M = song.M, beat = 60 / song.bpm
    const out = gain(ctx, 0.0001); out.connect(musicBus)
    const fadeIn = options.context ? 0.01 : 0.8
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeIn)
    const duck = gain(ctx, 1), lead = gain(ctx, 1), drums = gain(ctx, 1), rev = gain(ctx, M.rev)
    duck.connect(out); lead.connect(out); drums.connect(out); rev.connect(reverbIn)
    duck.connect(rev); lead.connect(rev); drums.connect(rev)
    if (M.delay) {
      const dl = ctx.createDelay(2), fb = gain(ctx, 0.38), wet = gain(ctx, M.delay), tone = ctx.createBiquadFilter()
      dl.delayTime.value = beat * 0.75; tone.type = "lowpass"; tone.frequency.value = 2800
      lead.connect(dl); dl.connect(tone); tone.connect(fb); fb.connect(dl); tone.connect(wet); wet.connect(out)
    }
    const tr = { song, out, duck, lead, drums, step: 0, next: ctx.currentTime + 0.08, sixteenth: beat / 4, stopped: false }
    track = tr; tracks.add(tr)
    if (options.context) pump(tr, options.prerender ?? 8)
    else tr.timer = setInterval(() => pump(tr, 0.3), 25)
  }

  function pump(tr, horizon) {
    const now = ctx.currentTime
    if (tr.next < now - 0.1) tr.next = now + 0.05 // the page was throttled: don't catch up in a burst
    while (tr.next < now + horizon) {
      const s = tr.step, bar = Math.floor(s / 16) % 8
      try { playStep(tr, bar, s % 16, tr.next + (tr.song.M.flat ? 0 : (Math.random() - 0.5) * 0.006), s) } catch (e) { warn("music step failed:", e?.message); tr.stopped = true; clearInterval(tr.timer); return }
      tr.next += tr.sixteenth; tr.step++
    }
  }

  function playStep(tr, bar, st, t, abs) {
    const { song, duck, lead, drums } = tr, M = song.M, I = intensity, step = tr.sixteenth
    const ch = song.chords[bar], c = ctx, scale = song.scale, root = song.root
    const fold = (m, lo) => { while (m < lo) m += 12; while (m >= lo + 12) m -= 12; return m }
    // pad: the chord, held through its bars
    if (M.pad && st === 0 && (M.hr === 1 || bar % 2 === 0)) {
      const len = step * 16 * M.hr, vel = 0.7 + 0.3 * I
      ch.pcs.forEach((pc) => voice(c, duck, t, fold(root + pc, root + 3), len, M.pad, vel))
    }
    // bass
    const bassMidi = fold(root + ch.pcs[0], root - 12)
    if (M.bass === "drone") {
      if (st === 0 && bar % 2 === 0) { voice(c, duck, t, bassMidi - (M.drums ? 0 : 12), step * 32, M.bassV, 0.9); if (song.mood === "spooky" && I > 0.3) voice(c, duck, t, bassMidi + 6, step * 32, "bassSub", 0.25) }
    } else {
      for (const [s, off, len] of BASS[M.bass]) if (s === st) voice(c, duck, t, bassMidi + off, len * step * 0.95, M.bassV, 1)
    }
    // drums
    const D = M.drums && DRUMS[M.drums]
    if (D) {
      const on = (p) => p && p[st] === "x"
      const lowTop = M.drums === "heart" ? I > 0.35 : true
      if (on(D.kick) && lowTop) kick(c, drums, t, M.drums === "heart" ? 0.8 : 1, M.drums === "heart")
      if (M.drums === "heart" && st === 4 && I > 0.35) kick(c, drums, t, 0.45, true)
      if (on(D.snare)) song.mood === "chiptune" ? noise(c, drums, t, { dur: 0.11, vol: 0.3, hp: 1800 }) : snare(c, drums, t, 0.9)
      if (on(D.clap)) clap(c, drums, t)
      if (D.hat && I >= 0.2) { const full = I >= 0.65; if (on(D.hat) || (full && st % 2 === 1)) hat(c, drums, t, st % 4 === 2 ? 1 : 0.6, false) }
      if (M.drums === "floor" && I >= 0.2 && st % 4 === 2) hat(c, drums, t, 1, true)
      if (M.drums === "march" && I > 0.5 && st % 4 === 0) tom(c, drums, t, bar % 2 ? 110 : 90, 0.5)
      if (bar % 4 === 3 && st >= 12 && I > 0.5 && M.drums !== "heart") snare(c, drums, t, 0.4 + 0.1 * (st - 12))
      if (M.duck && D.kick?.[st] === "x") { // sidechain: the pads and bass duck on every kick
        duck.gain.cancelScheduledValues(t); duck.gain.setValueAtTime(1 - M.duck, t); duck.gain.linearRampToValueAtTime(1, t + step * 3.2)
      }
    }
    if (M.crash && bar === 0 && st === 0 && I > 0.3) crash(c, drums, t)
    // arpeggio over the chord
    const arpOn = M.arp && I >= M.arpAt
    if (arpOn && st % (song.mood === "chiptune" ? 1 : 2) === 0) {
      const seq = song.arp, i = Math.floor(st / (song.mood === "chiptune" ? 1 : 2)) % seq.length
      const tones = ch.pcs.map((pc) => root + 12 + pc); if (song.mood !== "chiptune") tones.push(tones[0] + 12)
      const m = tones[seq[i] % tones.length] + (song.mood === "chiptune" ? 12 : 0)
      const v = (M.arp === "bell" ? 0.45 : 0.55) * (st % 4 === 0 ? 1 : 0.7)
      voice(c, song.mood === "chiptune" ? lead : duck, t, m, step * 2, M.arp, v)
    }
    // lead melody: more of it as the intensity rises
    const n = song.melody[bar].find((x) => x.st === st)
    if (n && (song.thin[bar * 16 + st] < 0.55 + 0.45 * I || M.hr === 2)) {
      const m = root + 12 + sd(scale, n.deg) + (bar >= 4 && I > 0.75 ? 12 : 0)
      voice(c, lead, t, m, n.len * step * 0.92, M.lead, st === 0 ? 1 : 0.85)
    }
    // spooky creaks and distant chimes
    if (M.creak && st === 0 && song.chance[abs % 128] < 0.3 + 0.3 * I) {
      noise(c, lead, t + step * Math.floor(song.chance[(abs + 5) % 128] * 12), { dur: 1.4, vol: 0.05, bp: [900, 400], q: 12, a: 0.4 })
    }
  }

  const api = {
    play, music,
    mute(on = true) { muted = !!on; if (ctx) { const t = ctx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(muted ? 0 : volume, t, 0.03) } },
    get muted() { return muted },
    get intensity() { return intensity },
    set intensity(v) { intensity = clamp(+v || 0, 0, 1) },
    get volume() { return volume },
    set volume(v) { volume = clamp(+v || 0, 0, 1); if (ctx && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03) },
    get context() { return ctx },
    get running() { return !!ctx && ctx.state === "running" },
  }
  return api
}
