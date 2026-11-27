// Shapes: characters, vehicles and world pieces built from primitives, coloured for the look.
// Each returns a THREE.Group standing on y = 0 and facing +Z (the way Object3D.lookAt aims).
// Characters, vehicles and some pieces have userData.animate(time, speed) to call each frame.
// Options (all optional): { color, look, scale }. Glowing parts use HDR colours, so they bloom.
import * as THREE from "three"
import { looks, getLook } from "./looks.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// ------------------------------------------------------------ helpers
const O = (o) => (o && typeof o === "object" ? o : {})
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d)
let defaultLook = null
export const setLook = (name) => { defaultLook = name } // a default look for shapes made without one
const lookOf = (o) => getLook(O(o).look ?? defaultLook, "shapes")
const lookName = (L) => Object.keys(looks).find((k) => looks[k] === L) || "neon"
const mats = new Map()
const std = (color, extra = {}) => {
  const key = color + JSON.stringify(extra)
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra }))
  return mats.get(key)
}
const glowCache = new Map()
const glow = (color, k = 3) => { // an unlit HDR colour: blooms
  const key = color + ":" + k
  if (!glowCache.has(key)) glowCache.set(key, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: true }))
  return glowCache.get(key)
}
const lighten = (c, f) => new THREE.Color(c).lerp(new THREE.Color(0xffffff), f).getHex()
const darken = (c, f) => new THREE.Color(c).lerp(new THREE.Color(0x000000), f).getHex()
const mix = (a, b, f) => new THREE.Color(a).lerp(new THREE.Color(b), f).getHex()
const SKIN = 0xffd3b0, INK = 0x14121c
const geos = {
  sphere: (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h),
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  cyl: (rt, rb, h, s = 16) => new THREE.CylinderGeometry(rt, rb, h, s),
  cap: (r, l) => new THREE.CapsuleGeometry(r, l, 4, 12),
  cone: (r, h, s = 12) => new THREE.ConeGeometry(r, h, s),
  torus: (r, t, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, 8, 24, arc),
}
// add(parent, geometry, material, [x, y, z], [sx, sy, sz], [rx, ry, rz]) → the mesh
const add = (parent, geo, mat, p = [0, 0, 0], s = [1, 1, 1], r = [0, 0, 0]) => {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(...p); m.scale.set(...s); m.rotation.set(...r)
  m.castShadow = true; m.receiveShadow = true
  parent.add(m)
  return m
}
const pivot = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g }
const finish = (g, o, animate) => {
  const sc = num(O(o).scale, 1)
  if (sc !== 1) g.scale.setScalar(sc)
  if (animate) g.userData.animate = (t = 0, speed = 1) => { try { animate(num(t, 0), num(speed, 1)) } catch {} }
  else g.userData.animate = () => {}
  return g
}
// big glossy eyes with a catch-light, on a face at (0, y, z) facing +Z
const eyes = (parent, y, z, gap, r, iris = INK) => {
  const out = []
  for (const sx of [-1, 1]) {
    const e = pivot(parent, sx * gap, y, z)
    add(e, geos.sphere(r, 16, 12), std(0xffffff, { roughness: 0.2 }), [0, 0, 0], [1, 1.15, 0.6])
    add(e, geos.sphere(r * 0.62, 12, 10), std(iris, { roughness: 0.1 }), [0, -r * 0.05, r * 0.45], [1, 1.1, 0.5])
    add(e, geos.sphere(r * 0.2, 8, 6), glow(0xffffff, 1.5), [r * 0.2, r * 0.3, r * 0.78])
    out.push(e)
  }
  return out
}
const smile = (parent, y, z, r = 0.05, color = 0x3a1a1a) => add(parent, geos.torus(r, r * 0.22, Math.PI), std(color), [0, y, z], [1, 1, 1], [0, 0, Math.PI])
const blush = (parent, y, z, gap, r) => { for (const sx of [-1, 1]) add(parent, geos.sphere(r, 10, 8), std(0xff8aa0, { roughness: 1 }), [sx * gap, y, z], [1, 0.6, 0.3]) }
// a two-legged walk shared by the characters
const walker = (g, { legs, arms = [], body, head, base = 0, amp = 0.8, rate = 9 }) => {
  const by = body ? body.position.y : 0
  return (t, speed) => {
    const s = Math.min(Math.abs(speed), 2)
    if (s < 0.05) { // idle: breathe
      for (const l of legs) l.rotation.x *= 0.8
      arms.forEach((a, i) => (a.rotation.x = Math.sin(t * 2 + i) * 0.05))
      if (body) body.position.y = by + Math.sin(t * 2) * 0.012
      if (head) head.rotation.z = Math.sin(t * 1.3) * 0.04
      return
    }
    const w = t * rate * (0.55 + s * 0.45), k = Math.min(s, 1.2) * amp
    legs[0].rotation.x = Math.sin(w) * k; legs[1].rotation.x = -Math.sin(w) * k
    if (arms[0]) { arms[0].rotation.x = -Math.sin(w) * k * 0.8; arms[1].rotation.x = Math.sin(w) * k * 0.8 }
    if (body) body.position.y = by + Math.abs(Math.sin(w)) * 0.035
    if (head) head.rotation.z = Math.sin(w) * 0.05
  }
}
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

// ------------------------------------------------------------ characters
export const hero = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent
  const legs = [-1, 1].map((sx) => { const l = pivot(g, sx * 0.1, 0.3, 0); add(l, geos.cap(0.065, 0.14), std(darken(c, 0.35)), [0, -0.14, 0]); add(l, geos.sphere(0.09, 12, 8), std(L.accent2), [0, -0.27, 0.035], [1, 0.6, 1.4]); return l })
  const body = pivot(g, 0, 0, 0)
  add(body, geos.cap(0.17, 0.18), std(c), [0, 0.47, 0])
  add(body, geos.torus(0.17, 0.025), glow(L.accent2, 2.2), [0, 0.37, 0], [1, 1, 1], [Math.PI / 2, 0, 0])
  const arms = [-1, 1].map((sx) => { const a = pivot(body, sx * 0.23, 0.56, 0); add(a, geos.cap(0.05, 0.14), std(c), [0, -0.1, 0], [1, 1, 1], [0, 0, sx * 0.15]); add(a, geos.sphere(0.065, 10, 8), std(SKIN), [sx * 0.02, -0.22, 0]); return a })
  const head = pivot(body, 0, 0.82, 0)
  add(head, geos.sphere(0.27), std(SKIN, { roughness: 0.7 }))
  add(head, new THREE.SphereGeometry(0.29, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), std(L.accent2), [0, 0.02, -0.02], [1, 1, 1], [-0.25, 0, 0])
  add(head, geos.box(0.3, 0.05, 0.12), std(L.accent2), [0, 0.12, 0.27], [1, 1, 1], [0.2, 0, 0]) // cap brim
  eyes(head, -0.01, 0.235, 0.095, 0.058)
  smile(head, -0.1, 0.255, 0.045); blush(head, -0.07, 0.24, 0.17, 0.04)
  add(body, geos.torus(0.12, 0.035), glow(c, 2), [0, 0.67, 0.02], [1, 1, 1], [Math.PI / 2, 0, 0]) // glowing collar
  return finish(g, o, walker(g, { legs, arms, body, head }))
}

export const robot = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(0xe8edf5, L.accent2, 0.15)
  const legs = [-1, 1].map((sx) => { const l = pivot(g, sx * 0.1, 0.26, 0); add(l, geos.cyl(0.045, 0.045, 0.18), std(0x555a66, { metalness: 0.6 }), [0, -0.1, 0]); add(l, geos.box(0.14, 0.07, 0.2), std(L.accent), [0, -0.22, 0.03]); return l })
  const body = pivot(g, 0, 0, 0)
  add(body, geos.box(0.36, 0.3, 0.26), std(c, { metalness: 0.3, roughness: 0.35 }), [0, 0.42, 0])
  add(body, geos.box(0.2, 0.12, 0.02), glow(L.accent, 2.4), [0, 0.43, 0.135])
  const arms = [-1, 1].map((sx) => { const a = pivot(body, sx * 0.25, 0.52, 0); add(a, geos.cyl(0.04, 0.04, 0.22), std(0x555a66, { metalness: 0.6 }), [0, -0.1, 0]); add(a, geos.sphere(0.065, 10, 8), std(L.accent), [0, -0.23, 0]); return a })
  const head = pivot(body, 0, 0.68, 0)
  add(head, geos.box(0.4, 0.3, 0.3), std(c, { metalness: 0.3, roughness: 0.35 }), [0, 0.15, 0])
  add(head, geos.box(0.32, 0.17, 0.04), std(INK, { roughness: 0.15 }), [0, 0.16, 0.15])
  const eyeL = [-1, 1].map((sx) => add(head, geos.box(0.07, 0.09, 0.03), glow(L.accent2, 3.2), [sx * 0.08, 0.16, 0.175]))
  add(head, geos.cyl(0.012, 0.012, 0.14, 6), std(0x555a66), [0, 0.37, 0])
  const ant = add(head, geos.sphere(0.035, 10, 8), glow(L.accent, 3), [0, 0.45, 0])
  for (const sx of [-1, 1]) add(head, geos.cyl(0.04, 0.04, 0.05, 10), std(L.accent), [sx * 0.215, 0.15, 0], [1, 1, 1], [0, 0, Math.PI / 2])
  const walk = walker(g, { legs, arms, body, head })
  return finish(g, o, (t, s) => {
    walk(t, s)
    ant.position.x = Math.sin(t * 5) * 0.015
    const blink = t % 3.2 < 0.12 ? 0.1 : 1
    eyeL.forEach((e) => (e.scale.y = blink))
  })
}

export const slime = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(L.accent2, 0x7cff9a, 0.5)
  const b = pivot(g, 0, 0, 0)
  add(b, geos.sphere(0.42, 28, 18), std(c, { transparent: true, opacity: 0.88, roughness: 0.12, emissive: c, emissiveIntensity: 0.35 }), [0, 0.3, 0], [1, 0.78, 1])
  add(b, geos.sphere(0.2, 14, 10), std(darken(c, 0.35), { transparent: true, opacity: 0.6 }), [0, 0.2, -0.05], [1, 0.7, 1])
  add(b, geos.sphere(0.07, 8, 6), glow(0xffffff, 1.4), [-0.18, 0.5, 0.18], [1, 0.6, 0.6], [0, 0.4, -0.5])
  eyes(b, 0.34, 0.34, 0.14, 0.09, INK)
  smile(b, 0.2, 0.39, 0.06); blush(b, 0.26, 0.37, 0.27, 0.05)
  return finish(g, o, (t, s) => {
    const hop = s > 0.05 ? Math.abs(Math.sin(t * 5 * Math.min(s, 1.5))) : 0
    const sq = 1 + Math.sin(t * 4) * 0.06 + (s > 0.05 ? (0.5 - hop) * 0.2 : 0)
    b.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq))
    b.position.y = hop * 0.25
  })
}

export const knight = (o) => {
  const L = lookOf(o), g = new THREE.Group(), steel = std(O(o).color ?? 0xaab4c4, { metalness: 0.75, roughness: 0.3 }), trim = std(L.accent, { metalness: 0.5, roughness: 0.35 })
  const legs = [-1, 1].map((sx) => { const l = pivot(g, sx * 0.1, 0.3, 0); add(l, geos.cap(0.07, 0.15), steel, [0, -0.14, 0]); add(l, geos.box(0.14, 0.07, 0.22), trim, [0, -0.28, 0.04]); return l })
  const body = pivot(g, 0, 0, 0)
  add(body, geos.cap(0.19, 0.16), steel, [0, 0.47, 0]); add(body, geos.box(0.4, 0.07, 0.3), trim, [0, 0.36, 0]); add(body, geos.box(0.1, 0.22, 0.02), trim, [0, 0.5, 0.19])
  for (const sx of [-1, 1]) add(body, geos.sphere(0.1, 12, 8), steel, [sx * 0.24, 0.62, 0], [1, 0.8, 1])
  const armL = pivot(body, -0.25, 0.58, 0), armR = pivot(body, 0.25, 0.58, 0)
  add(armL, geos.cap(0.05, 0.14), steel, [0, -0.1, 0]); add(armR, geos.cap(0.05, 0.14), steel, [0, -0.1, 0])
  add(armL, geos.cyl(0.17, 0.17, 0.04, 20), trim, [-0.08, -0.12, 0.08], [1, 1, 1], [0, 0, Math.PI / 2]) // shield
  add(armL, geos.sphere(0.05, 8, 6), glow(L.accent2, 2.5), [-0.105, -0.12, 0.08])
  const sword = pivot(armR, 0, -0.2, 0.05); sword.rotation.x = -0.9
  add(sword, geos.box(0.04, 0.4, 0.015), glow(mix(L.accent2, 0xffffff, 0.5), 2.2), [0, 0.22, 0]); add(sword, geos.box(0.14, 0.03, 0.04), trim, [0, 0.02, 0]); add(sword, geos.cyl(0.015, 0.015, 0.1, 6), std(0x3a2a20), [0, -0.04, 0])
  const head = pivot(body, 0, 0.82, 0)
  add(head, geos.sphere(0.25, 20, 14), steel, [0, 0, 0], [1, 1.05, 1])
  add(head, geos.box(0.3, 0.05, 0.1), std(INK), [0, 0.0, 0.2]); add(head, geos.box(0.05, 0.05, 0.02), glow(L.accent2, 3), [-0.07, 0, 0.255]); add(head, geos.box(0.05, 0.05, 0.02), glow(L.accent2, 3), [0.07, 0, 0.255])
  add(head, geos.cone(0.06, 0.28, 8), std(L.accent2, { roughness: 0.8 }), [0, 0.3, -0.04], [1, 1, 1], [-0.3, 0, 0]) // plume
  const walk = walker(g, { legs, arms: [armL, armR], body, head, amp: 0.7 })
  return finish(g, o, (t, s) => { walk(t, s); sword.rotation.x = -0.9 + Math.sin(t * (s > 0.05 ? 9 : 2)) * 0.1 })
}

export const ghost = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? 0xeaf2ff
  const m = std(c, { transparent: true, opacity: 0.88, roughness: 0.3, emissive: mix(c, L.accent2, 0.5), emissiveIntensity: 0.55 })
  const b = pivot(g, 0, 0.1, 0)
  add(b, geos.sphere(0.34, 24, 16), m, [0, 0.62, 0]); add(b, geos.cyl(0.34, 0.37, 0.5, 24), m, [0, 0.37, 0])
  const hem = []
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; hem.push(add(b, geos.sphere(0.13, 10, 8), m, [Math.cos(a) * 0.27, 0.1, Math.sin(a) * 0.27])) }
  eyes(b, 0.68, 0.29, 0.12, 0.07, INK); add(b, geos.sphere(0.04, 10, 8), std(INK), [0, 0.52, 0.33], [1, 1.3, 0.5])
  blush(b, 0.58, 0.31, 0.2, 0.045)
  const arms = [-1, 1].map((sx) => add(b, geos.sphere(0.09, 10, 8), m, [sx * 0.37, 0.45, 0.1], [0.8, 1.2, 0.8]))
  return finish(g, o, (t) => {
    b.position.y = 0.1 + Math.sin(t * 2) * 0.06; b.rotation.z = Math.sin(t * 1.4) * 0.07
    hem.forEach((h, i) => (h.position.y = 0.1 + Math.sin(t * 5 + i * 1.7) * 0.05))
    arms.forEach((a, i) => (a.rotation.z = Math.sin(t * 3 + i * 3) * 0.4))
  })
}

export const alien = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(L.accent2, 0x7aff7a, 0.6), skin = std(c, { roughness: 0.45 })
  const legs = [-1, 1].map((sx) => { const l = pivot(g, sx * 0.08, 0.28, 0); add(l, geos.cyl(0.03, 0.04, 0.26, 8), skin, [0, -0.13, 0]); add(l, geos.sphere(0.07, 10, 8), skin, [0, -0.27, 0.03], [1, 0.6, 1.4]); return l })
  const body = pivot(g, 0, 0, 0)
  add(body, geos.cap(0.13, 0.16), skin, [0, 0.4, 0]); add(body, geos.torus(0.13, 0.02), glow(L.accent, 2), [0, 0.38, 0], [1, 1, 1], [Math.PI / 2, 0, 0])
  const arms = [-1, 1].map((sx) => { const a = pivot(body, sx * 0.15, 0.5, 0); add(a, geos.cyl(0.025, 0.03, 0.26, 8), skin, [sx * 0.02, -0.12, 0], [1, 1, 1], [0, 0, sx * 0.1]); return a })
  const head = pivot(body, 0, 0.78, 0)
  add(head, geos.sphere(0.3, 24, 16), skin, [0, 0, 0], [1.1, 0.95, 1])
  for (const sx of [-1, 1]) {
    const e = pivot(head, sx * 0.13, -0.02, 0.24); e.rotation.z = sx * -0.45
    add(e, geos.sphere(0.12, 14, 10), std(INK, { roughness: 0.05 }), [0, 0, 0], [0.8, 1.3, 0.5]); add(e, geos.sphere(0.03, 8, 6), glow(0xffffff, 1.6), [-0.02, 0.07, 0.07])
    const an = pivot(head, sx * 0.13, 0.24, 0); an.rotation.z = sx * -0.35
    add(an, geos.cyl(0.01, 0.01, 0.2, 6), skin, [0, 0.1, 0]); add(an, geos.sphere(0.04, 10, 8), glow(L.accent, 3), [0, 0.21, 0])
  }
  add(head, geos.torus(0.04, 0.01, Math.PI), std(0x1a3a1a), [0, -0.14, 0.27], [1, 1, 1], [0, 0, Math.PI])
  const walk = walker(g, { legs, arms, body, head, amp: 0.6, rate: 7 })
  return finish(g, o, (t, s) => { walk(t, s); head.rotation.y = Math.sin(t * 1.1) * 0.15 })
}

export const critter = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(L.accent, 0xffb070, 0.5), fur = std(c, { roughness: 0.95 })
  const b = pivot(g, 0, 0, 0)
  add(b, geos.sphere(0.37, 24, 16), fur, [0, 0.37, 0], [1, 0.95, 0.95]); add(b, geos.sphere(0.24, 16, 12), std(lighten(c, 0.55), { roughness: 1 }), [0, 0.27, 0.17], [1, 1, 0.7])
  const ears = [-1, 1].map((sx) => { const e = pivot(b, sx * 0.23, 0.68, 0); e.rotation.z = sx * -0.35; add(e, geos.sphere(0.12, 12, 10), fur, [0, 0.04, 0], [0.8, 1.3, 0.6]); add(e, geos.sphere(0.07, 10, 8), std(0xff9ab0, { roughness: 1 }), [0, 0.04, 0.05], [0.8, 1.3, 0.4]); return e })
  eyes(b, 0.45, 0.31, 0.14, 0.085); add(b, geos.sphere(0.04, 10, 8), std(0xff7a94, { roughness: 0.4 }), [0, 0.36, 0.36], [1.2, 0.8, 0.8])
  smile(b, 0.31, 0.355, 0.045); blush(b, 0.36, 0.33, 0.25, 0.05)
  add(b, geos.sphere(0.12, 12, 10), std(lighten(c, 0.5), { roughness: 1 }), [0, 0.2, -0.38])
  const feet = [-1, 1].map((sx) => add(g, geos.sphere(0.09, 10, 8), fur, [sx * 0.17, 0.05, 0.12], [1, 0.7, 1.3]))
  return finish(g, o, (t, s) => {
    const hop = s > 0.05 ? Math.abs(Math.sin(t * 7 * Math.min(s, 1.5))) : 0
    b.position.y = hop * 0.22 + Math.sin(t * 2) * 0.01
    const sq = 1 + (0.5 - hop) * 0.12 * (s > 0.05 ? 1 : 0.1) + Math.sin(t * 2) * 0.015
    b.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq))
    ears.forEach((e, i) => (e.rotation.x = Math.sin(t * 6 + i) * 0.12 * (0.3 + hop)))
    feet.forEach((f, i) => (f.position.y = 0.05 + (s > 0.05 ? Math.max(0, Math.sin(t * 7 * s + i * Math.PI)) * 0.06 : 0)))
  })
}

// ------------------------------------------------------------ vehicles (nose towards +Z)
export const ship = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(0xdfe6f2, L.accent, 0.25), hull = std(c, { metalness: 0.45, roughness: 0.3 })
  const b = pivot(g, 0, 0.3, 0)
  add(b, geos.cone(0.2, 1.0, 10), hull, [0, 0, 0.1], [1, 0.75, 1], [Math.PI / 2, 0, 0]); add(b, geos.sphere(0.2, 14, 10), hull, [0, 0, -0.35], [1, 0.75, 1.2])
  add(b, geos.sphere(0.13, 14, 10), std(L.accent2, { transparent: true, opacity: 0.85, roughness: 0.05, emissive: L.accent2, emissiveIntensity: 0.9 }), [0, 0.1, 0.05], [1, 0.8, 1.7])
  for (const sx of [-1, 1]) {
    add(b, geos.box(0.62, 0.025, 0.36), std(L.accent, { metalness: 0.4 }), [sx * 0.4, -0.02, -0.2], [1, 1, 1], [0, sx * 0.45, sx * -0.08])
    add(b, geos.sphere(0.035, 8, 6), glow(L.accent2, 3.5), [sx * 0.66, -0.04, -0.37])
    add(b, geos.cyl(0.07, 0.09, 0.3, 10), std(0x39414f, { metalness: 0.7 }), [sx * 0.16, -0.03, -0.48], [1, 1, 1], [Math.PI / 2, 0, 0])
  }
  add(b, geos.box(0.025, 0.22, 0.3), std(L.accent), [0, 0.15, -0.42], [1, 1, 1], [0.3, 0, 0])
  const flames = [-1, 1].map((sx) => add(b, geos.cone(0.06, 0.4, 8), glow(L.accent2, 3.2), [sx * 0.16, -0.03, -0.8], [1, 1, 1], [-Math.PI / 2, 0, 0]))
  return finish(g, o, (t, s) => {
    b.position.y = 0.3 + Math.sin(t * 2.2) * 0.03; b.rotation.z = Math.sin(t * 1.3) * 0.08 - Math.min(s, 2) * 0.0
    flames.forEach((f, i) => f.scale.set(1, 0.8 + Math.min(Math.abs(s), 2) * 0.3 + Math.sin(t * 40 + i * 2) * 0.15, 1))
  })
}

export const car = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent
  add(g, geos.box(0.55, 0.17, 1.15), std(c, { metalness: 0.5, roughness: 0.25 }), [0, 0.2, 0]); add(g, geos.box(0.46, 0.15, 0.55), std(c, { metalness: 0.5, roughness: 0.25 }), [0, 0.35, -0.08], [1, 1, 1], [0.0, 0, 0])
  add(g, geos.box(0.44, 0.12, 0.5), std(INK, { roughness: 0.05, metalness: 0.8 }), [0, 0.36, -0.08]); add(g, geos.box(0.5, 0.02, 0.2), std(c), [0, 0.43, -0.1])
  for (const sx of [-1, 1]) { add(g, geos.box(0.12, 0.05, 0.03), glow(0xfff2c0, 3), [sx * 0.19, 0.22, 0.58]); add(g, geos.box(0.12, 0.05, 0.03), glow(0xff2030, 3), [sx * 0.19, 0.24, -0.58]) }
  const under = add(g, new THREE.PlaneGeometry(0.62, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(L.accent2).multiplyScalar(2.2), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }), [0, 0.04, 0], [1, 1, 1], [-Math.PI / 2, 0, 0]); under.castShadow = false
  const wheels = []
  for (const sx of [-1, 1]) for (const z of [-0.36, 0.36]) {
    const w = pivot(g, sx * 0.3, 0.13, z); add(w, geos.cyl(0.13, 0.13, 0.1, 16), std(0x1c1c24, { roughness: 0.8 }), [0, 0, 0], [1, 1, 1], [0, 0, Math.PI / 2]); add(w, geos.cyl(0.07, 0.07, 0.105, 10), std(0xd0d4dc, { metalness: 0.9, roughness: 0.2 }), [0, 0, 0], [1, 1, 1], [0, 0, Math.PI / 2]); wheels.push(w)
  }
  let phase = 0, last = 0
  return finish(g, o, (t, s) => { phase += Math.max(0, t - last) * s * 14; last = t; wheels.forEach((w) => (w.rotation.x = phase)); g.children[0].position.y = 0.2 + Math.sin(t * 25) * 0.003 * Math.min(Math.abs(s), 2) })
}

export const tank = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(0x6a7a4a, L.accent, 0.2), hull = std(c, { roughness: 0.6, metalness: 0.2 })
  const treads = [-1, 1].map((sx) => { const t = pivot(g, sx * 0.34, 0.14, 0); add(t, geos.box(0.2, 0.24, 1.0), std(0x23232b, { roughness: 0.9 })); for (const z of [-0.5, 0.5]) add(t, geos.cyl(0.12, 0.12, 0.2, 14), std(0x23232b, { roughness: 0.9 }), [0, 0, z], [1, 1, 1], [0, 0, Math.PI / 2]); for (let i = 0; i < 5; i++) add(t, geos.box(0.22, 0.03, 0.1), std(0x40404a), [0, 0.125, -0.4 + i * 0.2]); return t })
  add(g, geos.box(0.55, 0.2, 0.95), hull, [0, 0.27, 0]); add(g, geos.box(0.5, 0.06, 0.3), std(L.accent), [0, 0.34, 0.5], [1, 1, 1], [0.5, 0, 0])
  const turret = pivot(g, 0, 0.45, -0.05)
  add(turret, geos.cyl(0.22, 0.26, 0.17, 18), hull, [0, 0, 0]); add(turret, geos.cyl(0.05, 0.05, 0.6, 10), std(0x3a3f48, { metalness: 0.7 }), [0, 0.02, 0.45], [1, 1, 1], [Math.PI / 2, 0, 0])
  add(turret, geos.cyl(0.07, 0.07, 0.06, 10), std(L.accent), [0, 0.02, 0.74], [1, 1, 1], [Math.PI / 2, 0, 0]); add(turret, geos.sphere(0.07, 10, 8), glow(L.accent2, 2.5), [0, 0.12, 0.05])
  g.userData.turret = turret
  return finish(g, o, (t, s) => { treads.forEach((tr, i) => (tr.position.y = 0.14 + Math.sin(t * 30 + i) * 0.004 * Math.min(Math.abs(s), 2))); g.rotation.z = Math.sin(t * 18) * 0.006 * Math.min(Math.abs(s), 2) })
}

export const drone = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(0xe8edf5, L.accent2, 0.2)
  const b = pivot(g, 0, 0.55, 0)
  add(b, geos.sphere(0.22, 20, 14), std(c, { metalness: 0.4, roughness: 0.3 }), [0, 0, 0], [1, 0.7, 1]); add(b, geos.sphere(0.1, 14, 10), glow(L.accent, 3.2), [0, -0.02, 0.17], [1, 1, 0.5]); add(b, geos.sphere(0.05, 10, 8), std(INK), [0, -0.02, 0.2], [1, 1, 0.5])
  const rotors = []
  for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const a = Math.atan2(z, x); add(b, geos.box(0.3, 0.035, 0.05), std(0x39414f, { metalness: 0.6 }), [x * 0.2, 0, z * 0.2], [1, 1, 1], [0, -a, 0])
    const r = pivot(b, x * 0.36, 0.05, z * 0.36); add(r, geos.cyl(0.03, 0.03, 0.05, 8), std(0x39414f)); add(r, geos.cyl(0.17, 0.17, 0.008, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(L.accent2).multiplyScalar(1.3), transparent: true, opacity: 0.35, depthWrite: false }), [0, 0.04, 0]); add(r, geos.box(0.34, 0.006, 0.03), std(0x20242c), [0, 0.045, 0]); rotors.push(r)
  }
  return finish(g, o, (t, s) => { rotors.forEach((r, i) => (r.rotation.y = t * 40 * (i % 2 ? 1 : -1))); b.position.y = 0.55 + Math.sin(t * 2) * 0.05; b.rotation.x = Math.min(s, 2) * 0.12; b.rotation.z = Math.sin(t * 1.5) * 0.05 })
}

// ------------------------------------------------------------ world pieces
const TREES = { // [leaf, tip, trunk]
  day: [0x3f9a3a, 0x7fd250, 0x7a4a2a], meadow: [0x4f9e3a, 0xb0de50, 0x8a5a30], frost: [0x6fa0c8, 0xeaf6ff, 0x5a4a50], dusk: [0x7a3a6a, 0xff8a4a, 0x3a2230],
  neon: [0x2a1a7a, 0x19e6ff, 0x1a0a30], ember: [0x2a1410, 0xff4a1a, 0x1a0c08], void: [0x1a0f3a, 0x9b5cff, 0x0f0820], toxic: [0x14401a, 0x8aff1a, 0x0a1a0c],
}
const treePalette = (o) => TREES[lookName(lookOf(o))]
const rockColor = (o) => mix(lookOf(o).ground, 0x9a9aa8, 0.55)
const rockGeo = (r, seed) => {
  const rng = mulberry(seed), geo = new THREE.DodecahedronGeometry(r, 1), p = geo.attributes.position, v = new THREE.Vector3(), seen = new Map()
  for (let i = 0; i < p.count; i++) { // move shared corners together so the rock stays closed
    v.fromBufferAttribute(p, i); const k = v.x.toFixed(3) + v.y.toFixed(3) + v.z.toFixed(3)
    if (!seen.has(k)) seen.set(k, 0.78 + rng() * 0.4)
    v.multiplyScalar(seen.get(k)); v.y *= 0.8; p.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}
const colored = (geo, color) => { // paint a geometry's vertices for merging
  const c = new THREE.Color(color), n = geo.attributes.position.count, a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.toArray(a, i * 3)
  geo.setAttribute("color", new THREE.BufferAttribute(a, 3))
  return geo.index ? geo.toNonIndexed() : geo
}
const pineGeo = (pal) => {
  const parts = [colored(geos.cyl(0.07, 0.1, 0.4, 7).translate(0, 0.2, 0), pal[2])]
  for (let i = 0; i < 3; i++) parts.push(colored(geos.cone(0.5 - i * 0.12, 0.62, 8).translate(0, 0.55 + i * 0.36, 0), i === 2 ? mix(pal[0], pal[1], 0.7) : mix(pal[0], pal[1], i * 0.25)))
  return mergeGeometries(parts)
}
const roundGeo = (pal) => {
  const parts = [colored(geos.cyl(0.07, 0.1, 0.55, 7).translate(0, 0.27, 0), pal[2])]
  for (const [x, y, z, r, f] of [[0, 0.85, 0, 0.42, 0.2], [0.22, 0.7, 0.1, 0.28, 0.1], [-0.2, 0.75, -0.1, 0.3, 0.3], [0.02, 1.15, 0.05, 0.26, 0.7]]) parts.push(colored(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z), mix(pal[0], pal[1], f)))
  return mergeGeometries(parts)
}
const flat = (extra = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, ...extra })

export const tree = (o) => {
  const g = new THREE.Group(), pal = treePalette(o), kind = O(o).kind ?? (Math.random() < 0.5 ? "pine" : "round")
  const m = add(g, kind === "round" ? roundGeo(pal) : pineGeo(pal), flat())
  m.scale.setScalar(1.3)
  return finish(g, o, (t) => { m.rotation.z = Math.sin(t * 1.2 + g.position.x) * 0.012 })
}
export const rock = (o) => {
  const g = new THREE.Group(), c = O(o).color ?? rockColor(o), seed = (Math.random() * 1e6) | 0
  add(g, rockGeo(0.4, seed), std(c, { flatShading: true, roughness: 0.9 }), [0, 0.25, 0])
  add(g, rockGeo(0.2, seed + 1), std(lighten(c, 0.1), { flatShading: true, roughness: 0.9 }), [0.38, 0.12, 0.15])
  return finish(g, o)
}
export const crystal = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent2
  const m = std(c, { transparent: true, opacity: 0.92, roughness: 0.08, metalness: 0.2, emissive: c, emissiveIntensity: 1.3, flatShading: true })
  const rng = mulberry(7)
  for (const [x, z, h, tilt] of [[0, 0, 1, 0], [0.22, 0.1, 0.6, 0.35], [-0.2, 0.08, 0.7, -0.4], [0.05, -0.2, 0.5, 0.2], [-0.08, 0.22, 0.4, -0.15]]) add(g, new THREE.OctahedronGeometry(0.2, 0), m, [x, 0.2 * h + 0.05, z], [1, 2.4 * h, 1], [tilt * 0.4, rng() * 3, tilt])
  add(g, geos.cyl(0.4, 0.4, 0.01, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.2), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }), [0, 0.01, 0]).castShadow = false
  return finish(g, o, (t) => (m.emissiveIntensity = 1.3 + Math.sin(t * 2.5) * 0.4))
}

// windows: canvas textures, so buildings need no files
const winCache = new Map()
const windowTextures = (L) => {
  const key = lookName(L)
  if (winCache.has(key)) return winCache.get(key)
  const rng = mulberry(11), mk = () => { const c = document.createElement("canvas"); c.width = c.height = 256; return c }
  const base = mk(), em = mk(), b = base.getContext("2d"), e = em.getContext("2d")
  const body = L.night ? mix(L.ground, L.horizon, 0.3) : mix(L.horizon, 0xffffff, 0.35)
  b.fillStyle = "#" + new THREE.Color(body).getHexString(); b.fillRect(0, 0, 256, 256)
  e.fillStyle = "#000"; e.fillRect(0, 0, 256, 256)
  const lit = [0xffd890, 0xffe9b8, L.accent, L.accent2, 0xffd890]
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const x = i * 32 + 7, y = j * 32 + 7, on = rng() < (L.night ? 0.5 : 0.2)
    b.fillStyle = L.night ? "#0a0814" : "#" + new THREE.Color(mix(L.sky, 0x203050, 0.5)).getHexString(); b.fillRect(x, y, 18, 20)
    if (on) { e.fillStyle = "#" + new THREE.Color(lit[(rng() * lit.length) | 0]).getHexString(); e.fillRect(x, y, 18, 20) }
  }
  const tex = (cv, srgb) => { const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t }
  const r = { map: tex(base), emissive: tex(em), roof: body }
  winCache.set(key, r)
  return r
}
const buildingMats = (L) => {
  const w = windowTextures(L)
  return { side: new THREE.MeshStandardMaterial({ map: w.map, emissiveMap: w.emissive, emissive: 0xffffff, emissiveIntensity: L.night ? 1.9 : 0.6, roughness: 0.6 }), roof: std(darken(w.roof, 0.25), { roughness: 0.8 }) }
}
const towerParts = (sides, roofs, x, z, w, d, h, rng) => { // four walls and a roof, windows tiled by size
  for (const [ang, wf, off] of [[0, w, d / 2], [Math.PI, w, d / 2], [Math.PI / 2, d, w / 2], [-Math.PI / 2, d, w / 2]]) {
    const p = new THREE.PlaneGeometry(wf, h), uv = p.attributes.uv, ou = rng(), ov = rng()
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (wf / 4) + ou, uv.getY(i) * (h / 4) + ov)
    p.translate(0, h / 2, off).rotateY(ang).translate(x, 0, z)
    sides.push(p)
  }
  roofs.push(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, h + 0.001, z))
}
export const building = (o) => {
  const L = lookOf(o), g = new THREE.Group(), floors = Math.max(1, Math.round(num(O(o).floors, 5))), w = num(O(o).width, 1.6), h = floors * 0.5
  const sides = [], roofs = [], M = buildingMats(L), rng = mulberry((Math.random() * 1e6) | 0)
  towerParts(sides, roofs, 0, 0, w, w, h, rng)
  add(g, mergeGeometries(sides), M.side); add(g, mergeGeometries(roofs), M.roof)
  add(g, geos.box(w + 0.06, 0.06, w + 0.06), glow(O(o).color ?? L.accent, 1.8), [0, h + 0.03, 0])
  add(g, geos.cyl(0.015, 0.015, 0.4, 6), std(0x39414f), [0.2, h + 0.26, 0.2]); add(g, geos.sphere(0.04, 8, 6), glow(0xff2030, 3.5), [0.2, h + 0.48, 0.2])
  return finish(g, o)
}
export const tower = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(L.ground, 0xaab0c0, 0.5)
  for (let i = 0; i < 3; i++) { const r = 0.55 - i * 0.12; add(g, geos.cyl(r * 0.85, r, 0.9, 12), std(darken(c, i * 0.08), { roughness: 0.5 }), [0, 0.45 + i * 0.9, 0]); add(g, geos.torus(r * 0.9, 0.02), glow(i % 2 ? L.accent2 : L.accent, 2.4), [0, 0.88 + i * 0.9, 0], [1, 1, 1], [Math.PI / 2, 0, 0]) }
  add(g, geos.cone(0.22, 0.5, 10), std(L.accent, { metalness: 0.3 }), [0, 3.05, 0]); const b = add(g, geos.sphere(0.07, 10, 8), glow(L.accent2, 3.5), [0, 3.4, 0])
  return finish(g, o, (t) => b.scale.setScalar(1 + Math.sin(t * 4) * 0.25))
}
export const wall = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? mix(L.ground, 0xa8a8b8, 0.5), w = num(O(o).width, 1.2)
  add(g, geos.box(w, 0.7, 0.28), std(c, { roughness: 0.85 }), [0, 0.35, 0]); add(g, geos.box(w + 0.06, 0.08, 0.34), std(lighten(c, 0.15)), [0, 0.74, 0])
  for (let i = 0; i < 3; i++) add(g, geos.box(w + 0.02, 0.012, 0.29), std(darken(c, 0.25)), [0, 0.15 + i * 0.2, 0])
  add(g, geos.box(w * 0.7, 0.025, 0.295), glow(L.accent2, 1.8), [0, 0.64, 0])
  return finish(g, o)
}
export const crate = (o) => {
  const g = new THREE.Group(), c = O(o).color ?? 0xb98a4e, wood = std(c, { roughness: 0.85 }), dark = std(darken(c, 0.35), { roughness: 0.9 })
  add(g, geos.box(0.7, 0.7, 0.7), wood, [0, 0.35, 0])
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(g, geos.box(0.08, 0.74, 0.08), dark, [x * 0.33, 0.35, y * 0.33])
  for (const y of [0.03, 0.67]) { add(g, geos.box(0.74, 0.08, 0.74), dark, [0, y, 0]) }
  for (const s of [1, -1]) for (const r of [Math.PI / 4, -Math.PI / 4]) add(g, geos.box(0.9, 0.07, 0.03), dark, [0, 0.35, s * 0.355], [1, 1, 1], [0, 0, r])
  return finish(g, o)
}
export const chest = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? 0x9a5a2c, wood = std(c, { roughness: 0.75 }), gold = std(0xffc83c, { metalness: 0.9, roughness: 0.3, emissive: 0xaa6a00, emissiveIntensity: 0.6 })
  add(g, geos.box(0.8, 0.38, 0.5), wood, [0, 0.19, 0]); for (const x of [-0.28, 0.28]) add(g, geos.box(0.07, 0.4, 0.54), gold, [x, 0.2, 0])
  const lid = pivot(g, 0, 0.38, -0.25), half = (r, len, mat) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16, 1, false, 0, Math.PI), mat)
  const top = half(0.25, 0.8, wood); top.position.set(0, 0, 0.25); top.rotation.z = Math.PI / 2; top.castShadow = true; lid.add(top)
  for (const x of [-0.28, 0.28]) { const b = half(0.265, 0.07, gold); b.position.set(x, 0, 0.25); b.rotation.z = Math.PI / 2; lid.add(b) }
  add(g, geos.box(0.1, 0.12, 0.04), glow(L.accent, 2.5), [0, 0.36, 0.26])
  g.userData.open = (a = 1) => { lid.rotation.x = -Math.min(1, Math.max(0, a)) * 1.9 }
  return finish(g, o)
}
export const coin = (o) => {
  const g = new THREE.Group(), c = O(o).color ?? 0xffc83c, gold = std(c, { metalness: 0.9, roughness: 0.28, emissive: c, emissiveIntensity: 0.7 })
  const spin = pivot(g, 0, 0.45, 0)
  add(spin, geos.cyl(0.28, 0.28, 0.06, 28), gold, [0, 0, 0], [1, 1, 1], [Math.PI / 2, 0, 0]); add(spin, geos.torus(0.22, 0.015), glow(lighten(c, 0.3), 1.6), [0, 0, 0.035]); add(spin, geos.box(0.07, 0.22, 0.02), glow(lighten(c, 0.3), 1.6), [0, 0, 0.04])
  return finish(g, o, (t) => { spin.rotation.y = t * 2.8; spin.position.y = 0.45 + Math.sin(t * 2.5) * 0.04 })
}
export const gem = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent2, spin = pivot(g, 0, 0.45, 0)
  add(spin, new THREE.OctahedronGeometry(0.28, 0), std(c, { emissive: c, emissiveIntensity: 1.6, roughness: 0.05, metalness: 0.2, flatShading: true }), [0, 0, 0], [0.85, 1.35, 0.85])
  add(spin, new THREE.OctahedronGeometry(0.14, 0), glow(lighten(c, 0.5), 3), [0, 0, 0], [0.85, 1.35, 0.85])
  return finish(g, o, (t) => { spin.rotation.y = t * 1.8; spin.position.y = 0.45 + Math.sin(t * 2.2) * 0.05 })
}
export const heart = (o) => {
  const g = new THREE.Group(), c = O(o).color ?? 0xff2e63, s = new THREE.Shape()
  s.moveTo(0, -0.5); s.bezierCurveTo(-0.15, -0.3, -0.55, -0.1, -0.55, 0.15); s.bezierCurveTo(-0.55, 0.45, -0.2, 0.55, 0, 0.3); s.bezierCurveTo(0.2, 0.55, 0.55, 0.45, 0.55, 0.15); s.bezierCurveTo(0.55, -0.1, 0.15, -0.3, 0, -0.5)
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 4, curveSegments: 14 }).center()
  const spin = pivot(g, 0, 0.45, 0)
  const m = add(spin, geo, std(c, { emissive: c, emissiveIntensity: 1.1, roughness: 0.2 }), [0, 0, 0], [0.55, 0.55, 0.55])
  return finish(g, o, (t) => { const b = Math.pow(Math.max(0, Math.sin(t * 5)), 6); m.scale.setScalar(0.55 * (1 + b * 0.18)); spin.rotation.y = Math.sin(t * 1.5) * 0.5; spin.position.y = 0.45 + Math.sin(t * 2) * 0.04 })
}
export const portal = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent, c2 = L.accent2
  const ring = pivot(g, 0, 0.75, 0)
  add(ring, geos.torus(0.6, 0.07), glow(c, 2.4)); add(ring, geos.torus(0.72, 0.018), glow(c2, 2), [0, 0, 0], [1, 1, 1])
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color(c).multiplyScalar(2) }, uB: { value: new THREE.Color(c2).multiplyScalar(2) } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec2 v; void main(){ v = position.xy / 0.6; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform float uTime; uniform vec3 uA, uB; varying vec2 v; void main(){ float r = length(v); if (r > 1.0) discard; float a = atan(v.y, v.x); float s = sin(a * 3.0 + r * 9.0 - uTime * 3.0) * 0.5 + 0.5; float w = sin(r * 14.0 - uTime * 4.0) * 0.5 + 0.5; vec3 col = mix(uA, uB, s) * (0.35 + 0.65 * w) + vec3(1.0) * pow(1.0 - r, 4.0); gl_FragColor = vec4(col * (0.5 + 0.5 * r), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
  })
  add(ring, new THREE.CircleGeometry(0.6, 40), mat).castShadow = false
  const sparks = []
  for (let i = 0; i < 6; i++) sparks.push(add(ring, geos.sphere(0.025, 6, 4), glow(i % 2 ? c : c2, 4)))
  return finish(g, o, (t) => { mat.uniforms.uTime.value = t; ring.rotation.z = t * 0.2; sparks.forEach((s, i) => { const a = t * 1.2 + (i / 6) * 6.283; s.position.set(Math.cos(a) * 0.72, Math.sin(a) * 0.72, 0) }) })
}
export const flag = (o) => {
  const L = lookOf(o), g = new THREE.Group(), c = O(o).color ?? L.accent
  add(g, geos.cyl(0.025, 0.03, 1.5, 8), std(0xdfe3ea, { metalness: 0.6, roughness: 0.3 }), [0, 0.75, 0]); add(g, geos.sphere(0.05, 10, 8), glow(L.accent2, 2.4), [0, 1.52, 0])
  const cloth = new THREE.PlaneGeometry(0.7, 0.42, 14, 6), base = cloth.attributes.position.array.slice()
  add(g, cloth, std(c, { side: THREE.DoubleSide, roughness: 0.6, emissive: c, emissiveIntensity: 0.25 }), [0.36, 1.25, 0])
  return finish(g, o, (t) => {
    const p = cloth.attributes.position
    for (let i = 0; i < p.count; i++) { const x = base[i * 3] + 0.35; p.setZ(i, Math.sin(x * 9 - t * 6) * 0.045 * x) }
    p.needsUpdate = true; cloth.computeVertexNormals()
  })
}

// ------------------------------------------------------------ whole scenes
export const city = (o) => {
  const L = lookOf(o), g = new THREE.Group(), n = Math.max(1, Math.min(20, Math.round(num(O(o).blocks, 8)))), rng = mulberry(num(O(o).seed, 5))
  const sides = [], roofs = [], lights = [], strips = [], pitch = 12
  const half = (n - 1) / 2
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const bx = (i - half) * pitch, bz = (j - half) * pitch, centre = 1 - Math.hypot(i - half, j - half) / (half * 1.5 + 1)
    if (Math.abs(i - half) < 0.6 && Math.abs(j - half) < 0.6) continue // keep a plaza in the middle
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (rng() < 0.18) continue
      const w = 2.6 + rng() * 2.2, d = 2.6 + rng() * 2.2, h = 2 + rng() * 6 + centre * rng() * 14
      const x = bx + lx * 2.6 + (rng() - 0.5) * 0.5, z = bz + lz * 2.6 + (rng() - 0.5) * 0.5
      towerParts(sides, roofs, x, z, w, d, h, rng)
      if (h > 9) lights.push(new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(x, h + 0.2, z))
      if (L.night && rng() < 0.4) lights.push(new THREE.BoxGeometry(w + 0.08, 0.1, d + 0.08).translate(x, h * (0.5 + rng() * 0.45), z))
    }
    if (L.night) { strips.push(new THREE.PlaneGeometry(pitch - 0.5, 0.12).rotateX(-Math.PI / 2).translate(bx, 0.03, bz + pitch / 2)); strips.push(new THREE.PlaneGeometry(0.12, pitch - 0.5).rotateX(-Math.PI / 2).translate(bx + pitch / 2, 0.03, bz)) }
  }
  const M = buildingMats(L)
  if (sides.length) { add(g, mergeGeometries(sides), M.side); add(g, mergeGeometries(roofs), M.roof) }
  if (lights.length) { const l = add(g, mergeGeometries(lights), glow(0xff2030, 3.5)); l.castShadow = false }
  if (strips.length) { const s = add(g, mergeGeometries(strips), glow(L.accent2, 1.8)); s.castShadow = false; s.receiveShadow = false }
  return finish(g, o)
}
export const forest = (o) => {
  const L = lookOf(o), g = new THREE.Group(), opts = O(o), count = Math.max(1, Math.min(2000, Math.round(num(opts.count, 60)))), radius = num(opts.radius, 40), clear = Math.min(num(opts.clear, 4), radius * 0.5), rng = mulberry(num(opts.seed, 3))
  const pal = treePalette(opts), kinds = [{ geo: pineGeo(pal), n: Math.ceil(count * 0.5), s: [1, 1.7] }, { geo: roundGeo(pal), n: Math.ceil(count * 0.35), s: [0.9, 1.5] }, { geo: mergeGeometries([colored(rockGeo(0.4, 3), rockColor(opts))]), n: Math.ceil(count * 0.15), s: [0.9, 2.2] }]
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0)
  for (const k of kinds) {
    const mesh = new THREE.InstancedMesh(k.geo, flat(), k.n)
    mesh.castShadow = mesh.receiveShadow = true
    for (let i = 0; i < k.n; i++) {
      const r = clear + Math.sqrt(rng()) * (radius - clear), a = rng() * 6.2832, s = k.s[0] + rng() * (k.s[1] - k.s[0])
      p.set(Math.cos(a) * r, 0, Math.sin(a) * r); q.setFromAxisAngle(up, rng() * 6.2832); sc.set(s * (0.9 + rng() * 0.2), s, s * (0.9 + rng() * 0.2))
      mesh.setMatrixAt(i, m.compose(p, q, sc)); mesh.setColorAt(i, col.setScalar(0.8 + rng() * 0.35))
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true
    g.add(mesh)
  }
  return finish(g, o)
}
