// The city at night, behind both scenes: three rows of buildings, lit windows (a few flicker),
// and rain. Drawn with plain shapes, so it looks the same with or without WebGL. Whatever stands
// still is drawn once into a picture, so a big window costs no more per frame than a small one.
import { config } from "./config.js"

// The lettering of the title and the scores.
export const font = 'ui-monospace, Menlo, Consolas, "Courier New", monospace'

// A small random number generator that starts from a seed, so the city is the same on every load.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Each row, far to near: how lit its buildings are, how tall they stand, how wide they are.
const rows = [
  { lift: 0.16, top: 0.36, tall: 0.2, wide: [50, 90] },
  { lift: 0.11, top: 0.5, tall: 0.2, wide: [60, 110] },
  { lift: 0.07, top: 0.66, tall: 0.18, wide: [70, 130] },
]

export const drawCity = (scene) => {
  const { width, height } = scene.scale
  const random = seeded(7)
  const between = (min, max) => min + random() * (max - min)
  const night = Phaser.Display.Color.HexStringToColor(config.background)
  const neon = Phaser.Display.Color.HexStringToColor(config.accent)
  const mix = (amount) =>
    Phaser.Display.Color.GetColor(
      night.red + (neon.red - night.red) * amount,
      night.green + (neon.green - night.green) * amount,
      night.blue + (neon.blue - night.blue) * amount,
    )
  // A grey accent is a city with the power out: dim windows, no glow. A neon one lights it up,
  // and so does a pale, bright one (ice white).
  const power = Math.min(1, Math.max(neon.s * 2, (neon.v - 0.7) * 3.3))

  // First lay the buildings out, far to near, each with its windows (about a third are lit).
  const buildings = []
  rows.forEach((row, depth) => {
    const dim = 0.5 + depth * 0.25
    for (let x = -20; x < width; ) {
      const w = between(...row.wide)
      const top = height * (row.top + random() * row.tall)
      const building = { x, w, top, depth, lift: row.lift, windows: [], sign: false }
      for (let wy = top + 12; wy < height * 0.92; wy += 13)
        for (let wx = x + 8; wx < x + w - 8; wx += 10) {
          if (random() > 0.33) continue
          const alpha = dim * (0.15 + 0.85 * power) * between(0.5, 1)
          building.windows.push({ x: wx, y: wy, alpha, flickers: random() < 0.1 })
        }
      // A neon sign now and then on the nearest row.
      building.sign = depth === 2 && random() < 0.35 && w > 90
      buildings.push(building)
      x += w
    }
  })

  // Only some windows flicker (at most 60, spread over the whole width): the rest stay lit.
  const flickering = buildings.flatMap((building) => building.windows).filter((w) => w.flickers)
  const every = Math.ceil(flickering.length / 60)
  flickering.forEach((window, i) => (window.flickers = i % every === 0))

  // Everything that stands still is drawn once into one picture, so a big window costs no more
  // per frame than a small one.
  const glass = scene.add.graphics()
  for (const { x, w, top, depth, lift, windows, sign } of buildings) {
    glass.fillStyle(mix(lift)).fillRect(x, top, w + 1, height - top)
    for (const pane of windows) if (!pane.flickers) lit(glass, pane.x, pane.y, neon.color, pane.alpha, power)
    if (sign) {
      glass.fillStyle(neon.color, 0.1 + 0.5 * power).fillRect(x + w - 14, top + 6, 4, 36)
      glass.fillStyle(neon.color, 0.1 * power).fillRect(x + w - 19, top + 1, 14, 46)
    }
  }
  // Each scene has its own picture; a scene that starts again (the page was resized) replaces it.
  const key = "city-" + scene.scene.key
  if (scene.textures.exists(key)) scene.textures.remove(key)
  glass.generateTexture(key, Math.ceil(width), Math.ceil(height))
  glass.destroy()
  scene.add.image(0, 0, key).setOrigin(0)
  for (const { windows } of buildings)
    for (const pane of windows) if (pane.flickers) flicker(scene, pane.x, pane.y, neon.color, pane.alpha)

  // Rain: thin streaks in the accent colour, falling at a slant (at most 150).
  for (let i = 0; i < Math.min(150, Math.round(width / 14)); i++) {
    const streak = scene.add.rectangle(between(0, width), -20, 1, between(10, 20), neon.color, 0.2)
    streak.setRotation(0.12)
    scene.tweens.add({
      targets: streak,
      y: height + 20,
      x: streak.x - 60,
      duration: between(700, 1300),
      delay: between(0, 1300),
      repeat: -1,
    })
  }
}

// A lit window, with a faint larger square under it as its glow.
const lit = (glass, x, y, color, alpha, power) => {
  glass.fillStyle(color, 0.08 * power).fillRect(x - 3, y - 3, 10, 12)
  glass.fillStyle(color, alpha).fillRect(x, y, 4, 6)
}

// A window that slowly dims and brightens, on its own beat.
const flicker = (scene, x, y, color, alpha) => {
  const pane = scene.add.rectangle(x, y, 4, 6, color, alpha).setOrigin(0)
  scene.tweens.add({
    targets: pane,
    alpha: alpha * 0.15,
    duration: 600 + ((x * 37 + y * 11) % 1400),
    yoyo: true,
    repeat: -1,
  })
}
