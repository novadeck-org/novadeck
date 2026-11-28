# The kit

Ready parts for a game that looks and sounds finished from its first minute. Plain JavaScript
modules on three.js, nothing to build or install: import what you need from `../kit/<file>.js`
(from `src/`). Every part works alone, and every function has defaults, so the shortest call
already looks good. Read this file, not the kit's code.

```js
import { createStage } from "../kit/stage.js"
import { createSky } from "../kit/sky.js"
import { createGround } from "../kit/ground.js"
import { createParticles } from "../kit/particles.js"
import { createJuice } from "../kit/juice.js"
import { createAudio } from "../kit/audio.js"
import { createUI } from "../kit/ui.js"
import { createInput } from "../kit/input.js"
import * as shapes from "../kit/shapes.js"
import * as materials from "../kit/materials.js"
```

## Looks

Every part that has colours takes a `look`, one of: `"neon"` (night city, magenta and cyan),
`"dusk"` (warm orange sky, purple shadows), `"day"` (bright, soft, saturated), `"frost"` (pale
blue, white, cold light), `"ember"` (dark red, lava glow), `"void"` (black, deep space, violet),
`"meadow"` (greens, golden light), `"toxic"` (acid green on dark). `looks[name]` in
`kit/looks.js` holds each one's colours (`sky`, `horizon`, `fog`, `ground`, `accent`, `accent2`,
`light`, `shadow`) as hex numbers, for your own materials.

## stage.js — the scene, camera, lights and post-processing

```js
const stage = createStage({ look: "neon", camera: "orbit" })   // into <div id="game">
stage.scene, stage.camera, stage.renderer                       // three.js objects
stage.onFrame((dt, time) => { ... })                            // dt in seconds, capped at 0.05
stage.follow(object, { distance: 14, height: 9, lag: 0.12 })    // camera follows an object
```

- `camera`: `"orbit"` (drag to turn, wheel to zoom; the default), `"follow"` (behind and above
  whatever `follow` names, behind the way it moves), `"top"` (top-down, tilted), `"side"` (side-on, for a platformer),
  `"first"` (first person; `stage.lockPointer()` on a click), or `"fixed"`.
- Post-processing on by default: bloom (anything brighter than ~0.8 glows: use emissive
  colours or `materials.glow`), vignette, a little film grain, chromatic aberration at the
  edges, tone mapping. `stage.post.bloom = 1.2`, `.vignette`, `.grain`, `.aberration`,
  `.saturation` change them; `stage.post.pulse(strength)` flashes the bloom once.
- Lights for the look: a sun with soft shadows, a sky fill. `stage.sun` is the directional light.
  Add your own lights at the start and keep them in the scene: adding, removing or hiding one
  (or a group holding one) makes three.js recompile every shader, a freeze of up to a second.
  Turn a light off with `light.intensity = 0`; to take away a pickup, hide its meshes, not the
  group that holds its light.
- `stage.screenToGround(x, y)` → the point on the ground (y = 0) under a screen pixel, for
  aiming and clicking; `stage.worldToScreen(vector)` → `{ x, y, visible }` in CSS pixels.
- `stage.setLook("ember")` and `stage.setCamera("top")` switch at any time; `stage.timeScale`
  slows or speeds the game's time (`juice` uses it); `stage.post.flash(color, amount)`.
- Resizes itself and pauses while the page is hidden. A frame callback that throws is logged and
  skipped, never stops the game.

## sky.js, ground.js — the world around it

```js
stage.scene.add(createSky({ look: "neon", stars: true, aurora: false, clouds: false }))
stage.scene.add(createGround({ look: "neon", kind: "grid", size: 200 }))
```

- Skies are shaders: a gradient, stars that twinkle, an optional aurora or drifting clouds, a
  sun or moon disc (`sun: true`). Night looks get stars and a moon by default, day looks clouds
  and a sun.
- Ground `kind`: `"grid"` (glowing lines that pulse out from the centre), `"terrain"` (rolling
  hills, `height: 6`; `ground.heightAt(x, z)` to stand things on it), `"water"` (waves and
  glints), `"sand"`, `"snow"`, `"lava"` (flowing, glowing), `"tiles"` (a board, `tiles: 12`, for
  strategy and puzzle games; `ground.tileAt(x, z)` → `{ i, j }` or null off the board,
  `ground.tileCentre(i, j)` → a Vector3; tiles are 2 units, `tileSize` to change).

## particles.js — sparks, smoke, magic

```js
const fx = createParticles(stage)                 // one for the whole game
fx.burst("explosion", position)                   // a THREE.Vector3 or {x, y, z}
fx.burst("hit", position, { color: 0xff3366, count: 30 })
const trail = fx.emitter("trail", object)         // follows object until trail.stop()
fx.weather("rain")                                // "rain", "snow", "embers", "dust", "fireflies"
fx.weather(null)                                  // stops the weather; fx.clear() clears everything
```

Presets for `burst`: `"explosion"` (fireball, smoke, sparks and a shockwave ring), `"hit"`,
`"sparks"`, `"smoke"`, `"magic"` (swirling motes), `"heal"` (rising green), `"pickup"` (a ring
of glitter that rises), `"confetti"`, `"dust"` (a puff at the feet), `"portal"`, `"lightning"`
(a bolt from `position` to `{ to }`, or down from the sky without one). Emitters: `"trail"`, `"fire"`, `"smoke"`, `"thruster"`,
`"aura"`. Each takes `color`, `count` (per second for an emitter), `size`, `speed`. They glow under the stage's bloom.
Thousands at once are fine.

## juice.js — what makes a hit feel like a hit

```js
const juice = createJuice(stage)  // right after createStage, before your own onFrame
juice.shake(0.6)                  // camera shake, 0..1
juice.hitstop(0.08)               // freeze the game this many seconds (stage.onFrame gets dt 0)
juice.flash(0xffffff, 0.3)        // the screen flashes a colour
juice.slowmo(0.3, 1.5)            // time at 30% for 1.5 s
juice.punch(object, 1.3)          // squash and stretch an object's scale, springing back
juice.tween(object.position, { y: 2 }, { duration: 0.4, ease: "backOut" }) // → a promise
juice.float("+10", position, { color: 0xffd34d })  // a number that rises and fades
```

Eases: `linear`, `quadIn`, `quadOut`, `cubicOut`, `cubicInOut`, `sineInOut`, `backOut`,
`elasticOut`, `bounceOut`. A tween's promise has `.cancel()`.
`juice.time` is the game's own clock (scaled by `slowmo`, stopped by `hitstop`).

## shapes.js — models made in code

Each returns a `THREE.Group` standing on y = 0, about 1 unit tall unless said, facing +z,
coloured for the look: pass `{ look }` to each (or call `shapes.setLook(name)` once). Use them where a glTF model in `models/` isn't made yet, or for scenery.

- Characters: `shapes.hero({ color, look })`, `shapes.robot()`, `shapes.slime()`,
  `shapes.knight()`, `shapes.ghost()`, `shapes.alien()`, `shapes.critter()`; each has
  `.userData.animate(time, speed)` for a walk or bob, called each frame.
- Vehicles: `shapes.ship()`, `shapes.car()`, `shapes.tank()`, `shapes.drone()`.
- `shapes.tank()` has `.userData.turret` to aim; `shapes.chest()` has `.userData.open(0..1)`.
- World: `shapes.tree({ kind: "pine" })` (or `"round"`), `shapes.rock()`, `shapes.crystal()`, `shapes.building({ floors })`
  (lit windows), `shapes.tower()`, `shapes.wall()`, `shapes.crate()`, `shapes.chest()`,
  `shapes.coin()`, `shapes.gem()`, `shapes.heart()`, `shapes.portal()`, `shapes.flag()`.
- `shapes.city({ blocks: 8, look, seed })` and `shapes.forest({ count: 60, radius: 40, clear: 4 })`
  scatter a whole scene, with an open space in the middle.

## materials.js — shaders for things

`materials.toon({ color })` (cel shading with an outline: `materials.outline(mesh)`),
`materials.glow({ color, intensity })` (blooms), `materials.hologram({ color })` (scan lines,
flicker), `materials.forcefield({ color })` (a fresnel bubble with ripples:
`material.hit(point)` makes a ripple), `materials.dissolve({ color })` (`material.amount = 0..1`
burns it away with glowing edges), `materials.rim({ color, rim })` (a lit edge). Each animates
itself once it's on a mesh in a stage.

## audio.js — sound effects and music made in code

```js
const audio = createAudio()          // starts on the first click or key (browsers ask that)
audio.play("shoot")                  // each play varies a little
audio.play("explode", { volume: 0.8, pitch: 0.7 })
audio.music("action")                // a looping track made from a seed; audio.music(null) stops
audio.mute(true)                     // audio.mute(false) unmutes; audio.muted says which
```

Sounds: `shoot`, `laser`, `hit`, `hurt`, `explode`, `jump`, `land`, `pickup`, `coin`, `powerup`,
`heal`, `magic`, `step`, `dash`, `click`, `select`, `error`, `alarm`, `win`, `lose`, `levelup`.
Music moods: `"action"`, `"calm"`, `"spooky"`, `"heroic"`, `"chiptune"`, `"synthwave"`,
`"ambient"`; `audio.music("action", { seed: 7, tempo: 132 })` makes a different track.
`audio.intensity = 0..1` thickens the music as the game heats up.

## ui.js — title, HUD, banners, end screens

```js
const ui = createUI({ look: "neon" })
await ui.title({ name: "Neon Drift", tagline: "Outrun the dark", controls: ["WASD move", "Click shoot"] })
const hp = ui.bar("Health", { color: 0xff3366, max: 100 })    // hp.set(70), hp.add(-10), hp.value
const score = ui.counter("Score")                             // score.add(10), score.set(0)
const clock = ui.timer("Time", 90, () => ui.end({ won: false }))  // counts down; clock.left, .stop()
await ui.banner("Wave 2", { sub: "Faster now" })              // big text that sweeps in and out
ui.toast("Shield up")                                         // a small line that fades
ui.prompt("Press E to open")                                  // a line at the bottom; ui.prompt(null)
await ui.end({ won: true, title: "You escaped", stats: { Score: 1200 } })  // resolves on Play again
ui.pause(true)                                                // the pause screen (Esc does it too)
if (ui.paused) return                                         // in your frame loop: freeze while paused
```

`ui.title` resolves when the player presses Play (a click, so audio can start then). `ui.end`
shows a loss unless `won: true`. Timers stop while paused, and the HUD hides behind the title and
end screens. Everything is styled for the look, animated in, and clear of the game's own mouse
input. Each element has `.remove()`.

## input.js — keys, mouse, touch and gamepad as one

```js
const input = createInput(stage)
input.move          // { x, y } from WASD, arrows, a gamepad stick or a touch stick, length ≤ 1;
                    // x right is +1, up (W) is y = -1: on a ground plane, move z by input.move.y
input.aim           // the ground point under the mouse (stage.screenToGround)
input.held("fire")  // actions: "fire" (mouse, Space, gamepad A), "alt" (right mouse, E),
input.pressed("jump") // "jump" (Space, gamepad A), "dash" (Shift), "use" (E), "pause" (Esc)
input.on("fire", () => { ... })
```

`pressed` is true for one frame only. `input.bind("build", ["KeyB"])` adds an action of your own
(or replaces an action's keys). On a touch screen a stick appears on the left and a tap on the
right fires.
