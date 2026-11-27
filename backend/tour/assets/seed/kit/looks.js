// The eight looks. Each one is a set of colours (hex numbers) every kit part shares, so a
// game stays in one mood: sky (top), horizon, fog, ground, accent, accent2, light (the sun or
// moon), shadow (the tint in the dark). The rest tunes the lighting and post-processing.
//   sun: direction towards the sun/moon     fogDensity: how fast the world fades into fog
//   bloom / exposure / saturation: stage.post defaults     night: stars on by default
export const looks = {
  neon: {
    sky: 0x05020f, horizon: 0x34106a, fog: 0x1d0840, ground: 0x0b0716,
    accent: 0xff2bd6, accent2: 0x19e6ff, light: 0xa98bff, shadow: 0x0d0524,
    sun: [-0.35, 0.3, -0.9], sunPower: 2.2, fogDensity: 0.011, bloom: 1.25, exposure: 1.05, saturation: 1.15, night: true,
  },
  dusk: {
    sky: 0x2b1457, horizon: 0xff7a3d, fog: 0xb04a6c, ground: 0x2a1a3c,
    accent: 0xffa23c, accent2: 0xc04bff, light: 0xffb070, shadow: 0x3a1a5a,
    sun: [-0.3, 0.12, -0.9], sunPower: 3.4, fogDensity: 0.009, bloom: 1.0, exposure: 1.0, saturation: 1.2, night: false,
  },
  day: {
    sky: 0x2f7fe0, horizon: 0xc2e4ff, fog: 0xaed6f4, ground: 0x6cc24a,
    accent: 0xff5a3c, accent2: 0x2bb5ff, light: 0xfff1d6, shadow: 0x4a6aa0,
    sun: [0.45, 0.62, -0.55], sunPower: 4.2, fogDensity: 0.006, bloom: 0.55, exposure: 1.0, saturation: 1.15, night: false,
  },
  frost: {
    sky: 0x5f98d4, horizon: 0xe6f3ff, fog: 0xd2e6f6, ground: 0xc6dbee,
    accent: 0x7fd6ff, accent2: 0xa6a0ff, light: 0xdbeaff, shadow: 0x6a88b8,
    sun: [0.3, 0.32, -0.9], sunPower: 2.5, fogDensity: 0.009, bloom: 0.8, exposure: 0.95, saturation: 1.0, night: false,
  },
  ember: {
    sky: 0x0b0202, horizon: 0x5e1206, fog: 0x2e0a05, ground: 0x2c1109,
    accent: 0xff4a1a, accent2: 0xffb020, light: 0xff7a3a, shadow: 0x2a0604,
    sun: [-0.25, 0.2, -0.9], sunPower: 2.4, fogDensity: 0.012, bloom: 1.3, exposure: 1.1, saturation: 1.15, night: true,
  },
  void: {
    sky: 0x000001, horizon: 0x1a0836, fog: 0x080214, ground: 0x07030f,
    accent: 0x9b5cff, accent2: 0x4de1ff, light: 0xa58cff, shadow: 0x0a0418,
    sun: [0.4, 0.35, -0.85], sunPower: 1.8, fogDensity: 0.008, bloom: 1.3, exposure: 1.05, saturation: 1.1, night: true,
  },
  meadow: {
    sky: 0x4a9fe6, horizon: 0xf6ecb4, fog: 0xdcecb8, ground: 0x4f9e3a,
    accent: 0xffc83c, accent2: 0xff7aa8, light: 0xffe6a0, shadow: 0x305a40,
    sun: [0.5, 0.45, -0.6], sunPower: 4.0, fogDensity: 0.007, bloom: 0.6, exposure: 1.0, saturation: 1.2, night: false,
  },
  toxic: {
    sky: 0x010803, horizon: 0x0a3512, fog: 0x07200a, ground: 0x07140a,
    accent: 0x8aff1a, accent2: 0x20ffb0, light: 0x9aff6a, shadow: 0x04180a,
    sun: [-0.3, 0.25, -0.9], sunPower: 2.0, fogDensity: 0.013, bloom: 1.4, exposure: 1.05, saturation: 1.2, night: true,
  },
}

// A look by name: the look itself if it's an object, neon for an unknown or missing name.
export const getLook = (name, who = "kit") => {
  if (name && typeof name === "object") return name
  if (name == null) return looks.neon
  if (looks[name]) return looks[name]
  console.warn(`${who}: unknown look "${name}" (use ${Object.keys(looks).join(", ")}); using "neon".`)
  return looks.neon
}
