// ui.js — title screen, HUD, banners, toasts, prompt, end and pause screens as DOM overlays.
//   const ui = createUI({ look: "neon" })
//   await ui.title({ name: "Neon Drift", tagline: "Outrun the dark", controls: ["WASD move"] })
// One root element sits over the page with pointer-events: none, so the game's own mouse input
// still works; only buttons (and the full-screen title, end and pause screens) take clicks.
// The CSS is injected from here, tinted by the look's colours from ./looks.js.
import { getLook } from "./looks.js"

const hex = (n) => (typeof n === "string" ? n : "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6))
const rgb = (n) => (typeof n === "string" ? [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)] : [(n >> 16) & 255, (n >> 8) & 255, n & 255])
const mix = (a, b, k) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(",")})` }
const lighten = (n, k) => mix(n, 0xffffff, k)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const fmt = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : String(v ?? "")).toLocaleString?.() ?? String(v)
const DANGER = 0xff4d6d

const CSS = `
.kit-ui{position:fixed;inset:0;z-index:20;pointer-events:none;overflow:hidden;color:#fff;font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;--a:#ff2bd6;--b:#19e6ff;--glass:rgba(10,8,24,.58);--edge:rgba(255,255,255,.16)}
.kit-ui *{box-sizing:border-box}
.kit-glass{background:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.02)),var(--glass);border:1px solid var(--edge);border-radius:14px;backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);box-shadow:0 10px 34px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.2)}
.kit-hud{position:absolute;inset:0;transition:opacity .4s}
.kit-ui.has-overlay .kit-hud{opacity:0}
.kit-col{position:absolute;display:flex;flex-direction:column;gap:10px;padding:max(16px,env(safe-area-inset-top)) 18px}
.kit-tl{top:0;left:0;align-items:flex-start}.kit-tr{top:0;right:0;align-items:flex-end}
.kit-tc{position:absolute;top:0;left:50%;transform:translateX(-50%);padding:16px 0;display:flex;flex-direction:column;align-items:center;gap:10px}
/* bar */
.kit-bar{width:min(280px,42vw);padding:8px 12px 10px;animation:kit-in .45s cubic-bezier(.2,.9,.3,1.2) both}
.kit-bar .row{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.88;margin-bottom:6px}
.kit-bar .num{font-variant-numeric:tabular-nums;letter-spacing:.04em;opacity:.8}
.kit-bar .track{position:relative;height:12px;border-radius:99px;background:rgba(0,0,0,.45);overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.6)}
.kit-bar .ghost,.kit-bar .fill{position:absolute;inset:0 auto 0 0;border-radius:99px;width:100%;transform-origin:left}
.kit-bar .ghost{background:rgba(255,255,255,.55);transition:transform .7s ease .35s}
.kit-bar .fill{background:linear-gradient(180deg,var(--c2),var(--c) 55%,var(--c));box-shadow:0 0 14px var(--c),inset 0 1px 0 rgba(255,255,255,.5);transition:transform .22s cubic-bezier(.2,.8,.3,1)}
.kit-bar.low .fill{animation:kit-low .7s ease-in-out infinite alternate}
.kit-bar.flash{animation:kit-shake .3s}
/* counter and timer */
.kit-count{display:flex;align-items:baseline;gap:12px;padding:8px 16px 9px;animation:kit-in .45s cubic-bezier(.2,.9,.3,1.2) both}
.kit-count .lab{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;opacity:.75}
.kit-count .val{font-size:clamp(24px,4vw,34px);font-weight:800;font-variant-numeric:tabular-nums;line-height:1;text-shadow:0 0 18px var(--a);display:inline-block}
.kit-count .val.pop{animation:kit-pop .32s cubic-bezier(.2,.9,.3,1.6)}
.kit-timer .val{min-width:2.6ch;text-align:center}
.kit-timer.urgent{border-color:rgba(255,77,109,.7);animation:kit-urgent .5s ease-in-out infinite alternate}
.kit-timer.urgent .val{color:#ff8da1;text-shadow:0 0 18px #ff4d6d}
.kit-out{animation:kit-out .3s ease both!important}
/* banner */
.kit-banner{position:absolute;left:0;right:0;top:30%;display:flex;flex-direction:column;align-items:center;text-align:center;animation:kit-banner var(--d,2.4s) cubic-bezier(.2,.8,.2,1) both}
.kit-banner .t{font-size:clamp(40px,9vw,104px);font-weight:900;font-style:italic;letter-spacing:.04em;text-transform:uppercase;line-height:1;padding:.05em .3em;background:linear-gradient(180deg,#fff 20%,var(--c) 130%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 22px var(--c)) drop-shadow(0 4px 0 rgba(0,0,0,.35))}
.kit-banner .s{margin-top:8px;font-size:clamp(14px,2.2vw,22px);font-weight:600;letter-spacing:.3em;text-transform:uppercase;opacity:.9;text-shadow:0 2px 10px rgba(0,0,0,.6)}
.kit-banner:before{content:"";position:absolute;left:0;right:0;top:50%;height:min(14vw,140px);transform:translateY(-58%);background:linear-gradient(90deg,transparent,rgba(0,0,0,.45) 25%,rgba(0,0,0,.45) 75%,transparent);z-index:-1}
/* toast */
.kit-toasts{position:absolute;left:0;right:0;bottom:22%;display:flex;flex-direction:column-reverse;align-items:center;gap:8px}
.kit-toast{padding:9px 18px;font-size:15px;font-weight:600;letter-spacing:.02em;border-radius:99px;display:flex;align-items:center;gap:10px;animation:kit-toast var(--d,2.6s) cubic-bezier(.2,.9,.3,1.1) both}
.kit-toast:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c)}
/* prompt */
.kit-prompt{position:absolute;left:0;right:0;bottom:max(7%,44px);display:flex;justify-content:center}
.kit-prompt>div{padding:10px 22px;border-radius:99px;font-size:16px;font-weight:600;letter-spacing:.03em;display:flex;align-items:center;gap:10px;animation:kit-prompt 1.8s ease-in-out infinite alternate,kit-up .35s ease both}
.kit-prompt.off>div{animation:kit-out .25s ease both}
kbd.kit-key{font:inherit;font-size:.86em;font-weight:800;min-width:1.9em;text-align:center;padding:.18em .55em;border-radius:7px;background:linear-gradient(180deg,rgba(255,255,255,.32),rgba(255,255,255,.1));border:1px solid rgba(255,255,255,.4);box-shadow:0 2px 0 rgba(0,0,0,.45),0 0 12px color-mix(in srgb,var(--a) 50%,transparent);letter-spacing:.03em;text-transform:none}
/* screens */
.kit-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(12px,2.4vh,24px);padding:24px;pointer-events:auto;animation:kit-fade .5s ease both;text-align:center;overflow:hidden}
.kit-screen.leave{animation:kit-leave .45s ease both;pointer-events:none}
.kit-title{background:radial-gradient(ellipse 80% 60% at 50% 105%,var(--hz) 0,transparent 70%),radial-gradient(ellipse at 50% 40%,var(--bg1),var(--bg0) 85%);z-index:3}
.kit-title .orb{position:absolute;border-radius:50%;filter:blur(60px);opacity:.38;animation:kit-drift 14s ease-in-out infinite alternate;pointer-events:none}
.kit-title:after,.kit-end:after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 45%,rgba(0,0,0,.55));}
.kit-title>*,.kit-end>*,.kit-pause>*{position:relative;z-index:1}
.kit-name{margin:0;font-size:clamp(44px,10vw,124px);font-weight:900;font-style:italic;letter-spacing:.02em;text-transform:uppercase;line-height:.95;background:linear-gradient(100deg,#fff 0%,var(--a) 25%,var(--b) 50%,var(--a) 75%,#fff 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 28px color-mix(in srgb,var(--a) 70%,transparent)) drop-shadow(0 6px 0 rgba(0,0,0,.4));animation:kit-name 1s cubic-bezier(.2,.9,.2,1) both,kit-sheen 6s linear infinite}
.kit-tag{font-size:clamp(15px,2.4vw,24px);font-weight:500;letter-spacing:.34em;text-transform:uppercase;opacity:.88;animation:kit-up .8s .35s ease both;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.kit-ctl{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;max-width:760px;animation:kit-up .8s .55s ease both}
.kit-chip{display:flex;align-items:center;gap:9px;padding:7px 14px;border-radius:99px;font-size:14px;font-weight:600}
.kit-chip span{opacity:.85}
.kit-btn{pointer-events:auto;cursor:pointer;font:inherit;font-size:clamp(16px,2vw,20px);font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#fff;border:0;border-radius:99px;padding:.85em 2.6em;margin-top:8px;background:linear-gradient(100deg,var(--a),var(--b));box-shadow:0 0 0 1px rgba(255,255,255,.35) inset,0 10px 40px color-mix(in srgb,var(--a) 55%,transparent),0 0 60px color-mix(in srgb,var(--b) 30%,transparent);text-shadow:0 2px 8px rgba(0,0,0,.45);transition:transform .18s cubic-bezier(.2,.9,.3,1.4),filter .18s;animation:kit-up .8s .75s ease both,kit-glow 2.2s 1.6s ease-in-out infinite alternate}
.kit-btn:hover,.kit-btn:focus-visible{transform:scale(1.07);filter:brightness(1.15);outline:none}
.kit-btn:active{transform:scale(.97)}
.kit-btn.ghosty{background:rgba(255,255,255,.1);box-shadow:0 0 0 1px var(--edge) inset;animation:kit-up .6s .3s ease both;padding:.7em 2em}
.kit-hint{font-size:12px;letter-spacing:.2em;text-transform:uppercase;opacity:.55;animation:kit-up .8s 1s ease both}
.kit-end{background:radial-gradient(ellipse at center,rgba(0,0,0,.45),rgba(0,0,0,.82));backdrop-filter:blur(5px);z-index:4}
.kit-end.win{background:radial-gradient(ellipse at 50% 40%,color-mix(in srgb,var(--a) 22%,rgba(0,0,0,.4)),rgba(0,0,0,.84))}
.kit-end.lose{background:radial-gradient(ellipse at 50% 40%,rgba(120,10,30,.4),rgba(0,0,0,.88))}
.kit-end .kit-name{font-size:clamp(40px,8.5vw,100px)}
.kit-end.lose .kit-name{background-image:linear-gradient(100deg,#fff 0%,#ff4d6d 25%,#a01a3a 50%,#ff4d6d 75%,#fff 100%)}
.kit-end.lose .kit-name{filter:drop-shadow(0 0 28px rgba(255,77,109,.55)) drop-shadow(0 6px 0 rgba(0,0,0,.4))}
.kit-stats{display:flex;flex-direction:column;min-width:min(340px,80vw);padding:6px 22px}
.kit-stat{display:flex;justify-content:space-between;gap:36px;padding:12px 0;font-size:18px;border-bottom:1px solid rgba(255,255,255,.1);animation:kit-up .5s ease both}
.kit-stat:last-child{border:0}
.kit-stat b{font-variant-numeric:tabular-nums;font-size:22px}
.kit-stat span{opacity:.75;letter-spacing:.1em;text-transform:uppercase;font-size:13px;align-self:center}
.kit-conf{position:absolute;top:-6%;width:10px;height:16px;border-radius:2px;opacity:0;animation:kit-conf var(--t,4s) var(--w,0s) linear infinite;pointer-events:none;z-index:0}
.kit-pause{background:rgba(5,5,14,.55);backdrop-filter:blur(8px) saturate(.8);z-index:5}
.kit-pause .kit-name{font-size:clamp(36px,7vw,80px)}
.kit-card{padding:28px 44px;display:flex;flex-direction:column;align-items:center;gap:14px;animation:kit-pop .4s cubic-bezier(.2,.9,.3,1.3) both}
.kit-toggle{display:flex;gap:10px}
/* keyframes */
@keyframes kit-in{from{opacity:0;transform:translateY(-14px) scale(.96)}to{opacity:1;transform:none}}
@keyframes kit-up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes kit-out{to{opacity:0;transform:translateY(-10px) scale(.96)}}
@keyframes kit-fade{from{opacity:0}to{opacity:1}}
@keyframes kit-leave{to{opacity:0;transform:scale(1.06)}}
@keyframes kit-pop{0%{transform:scale(.88);opacity:.6}60%{transform:scale(1.18)}100%{transform:scale(1);opacity:1}}
@keyframes kit-low{from{filter:brightness(1)}to{filter:brightness(1.7) saturate(1.3)}}
@keyframes kit-shake{0%,100%{transform:none}25%{transform:translateX(-5px)}60%{transform:translateX(4px)}}
@keyframes kit-urgent{from{box-shadow:0 10px 34px rgba(0,0,0,.38)}to{box-shadow:0 0 28px rgba(255,77,109,.7)}}
@keyframes kit-banner{0%{opacity:0;transform:translateX(-14vw) skewX(-10deg);letter-spacing:.4em}14%{opacity:1;transform:translateX(0) skewX(0);letter-spacing:.04em}80%{opacity:1;transform:translateX(1.5vw)}100%{opacity:0;transform:translateX(16vw) skewX(10deg)}}
@keyframes kit-toast{0%{opacity:0;transform:translateY(18px) scale(.9)}10%{opacity:1;transform:none}85%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}
@keyframes kit-prompt{from{box-shadow:0 10px 34px rgba(0,0,0,.38),0 0 0 color-mix(in srgb,var(--a) 0%,transparent)}to{box-shadow:0 10px 34px rgba(0,0,0,.38),0 0 26px color-mix(in srgb,var(--a) 45%,transparent)}}
@keyframes kit-name{from{opacity:0;transform:translateY(30px) scale(.94);letter-spacing:.16em}to{opacity:1;transform:none}}
@keyframes kit-sheen{to{background-position:-200% 0}}
@keyframes kit-glow{from{filter:brightness(1)}to{filter:brightness(1.18)}}
@keyframes kit-drift{from{transform:translate(-6vw,-3vh) scale(1)}to{transform:translate(8vw,5vh) scale(1.25)}}
@keyframes kit-conf{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:1;transform:translateY(112vh) rotate(720deg)}}
@media (prefers-reduced-motion:reduce){.kit-ui *{animation-duration:.01s!important;animation-delay:0s!important}}
@media (max-width:560px){.kit-col{padding:12px}.kit-bar{width:46vw}.kit-name{letter-spacing:0}}
`

let styleEl = null
function injectCSS() {
  if (styleEl && styleEl.isConnected) return
  styleEl = document.getElementById("kit-ui-style") || el("style")
  styleEl.id = "kit-ui-style"; styleEl.textContent = CSS
  document.head.appendChild(styleEl)
}
const later = (ms, fn) => setTimeout(fn, ms)

// "WASD move" -> a key cap "WASD" and the words "move"
const KEYWORDS = /^(click|space|shift|esc|enter|mouse|arrows?|tap|drag|wheel|scroll|ctrl|alt|tab|left|right|touch)$/i
function chip(text) {
  const c = el("div", "kit-chip kit-glass"), parts = String(text).trim().split(/\s+/), first = parts[0] ?? ""
  if (parts.length > 1 && (/^[A-Z0-9/+←→↑↓]{1,8}$/.test(first) || KEYWORDS.test(first))) {
    c.append(el("kbd", "kit-key", first), el("span", "", parts.slice(1).join(" ")))
  } else c.append(el("span", "", String(text)))
  return c
}
// "Press E to open" -> the key in a cap
function promptNodes(text) {
  const m = /^(.*?\b(?:press|hit|tap|hold)\s+)(\S+?)(\s.*|)$/i.exec(text)
  if (!m) return [document.createTextNode(text)]
  return [document.createTextNode(m[1]), el("kbd", "kit-key", m[2]), document.createTextNode(m[3])]
}

export function createUI(options = {}) {
  injectCSS()
  const look = getLook(options.look, "createUI")
  const root = el("div", "kit-ui")
  const set = (k, v) => root.style.setProperty(k, v)
  set("--a", hex(look.accent)); set("--b", hex(look.accent2))
  set("--glass", mix(look.sky, 0x05060c, 0.72).replace("rgb(", "rgba(").replace(")", ",.62)"))
  set("--bg0", mix(look.sky, 0x000000, 0.7)); set("--bg1", mix(look.sky, look.accent, 0.16)); set("--hz", mix(look.horizon, 0x000000, 0.35))
  const hud = el("div", "kit-hud"), tl = el("div", "kit-col kit-tl"), tr = el("div", "kit-col kit-tr"), tc = el("div", "kit-tc")
  const toasts = el("div", "kit-toasts"), promptBox = el("div", "kit-prompt")
  hud.append(tl, tr, tc, toasts, promptBox)
  root.append(hud)
  ;(document.body || document.documentElement).appendChild(root)

  let paused = false, pauseEl = null, titleEl = null, endEl = null, titleDone = null
  const pauseListeners = new Set(), timers = new Set()
  const sync = () => root.classList.toggle("has-overlay", !!(titleEl || endEl))
  const leave = (node, ms = 450) => { node.classList.add("leave"); later(ms, () => node.remove()) }
  const colorOf = (c, d) => hex(c ?? d)

  // ----- HUD -----
  function bar(label = "Health", o = {}) {
    const max = Math.max(1, +o.max || 100), c = colorOf(o.color, look.accent)
    const box = el("div", "kit-bar kit-glass"), row = el("div", "row"), track = el("div", "track")
    const lab = el("span", "", label), num = el("span", "num"), ghost = el("div", "ghost"), fill = el("div", "fill")
    box.style.setProperty("--c", c); box.style.setProperty("--c2", lighten(o.color ?? look.accent, 0.45))
    row.append(lab, num); track.append(ghost, fill); box.append(row, track); tl.append(box)
    const api = { value: 0, max, el: box }
    const paint = (v) => {
      const f = Math.min(1, Math.max(0, v / api.max))
      fill.style.transform = ghost.style.transform = `scaleX(${f})`
      if (v >= api.value) ghost.style.transitionDelay = "0s"; else ghost.style.transitionDelay = ".35s"
      num.textContent = `${Math.round(v)} / ${Math.round(api.max)}`
      box.classList.toggle("low", f <= 0.25 && f > 0)
      if (v < api.value) { box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash") }
      api.value = v
    }
    api.set = (v = 0) => { paint(Math.min(api.max, Math.max(0, +v || 0))); return api }
    api.add = (d = 0) => api.set(api.value + (+d || 0))
    api.remove = () => { box.classList.add("kit-out"); later(300, () => box.remove()) }
    api.set(o.value ?? max)
    return api
  }

  function counter(label = "Score", o = {}) {
    const box = el("div", "kit-count kit-glass"), lab = el("span", "lab", label), val = el("span", "val", "0")
    box.append(lab, val); tr.append(box)
    const api = { value: 0, el: box }
    let shown = 0, raf = 0
    const tween = (to) => {
      cancelAnimationFrame(raf)
      const from = shown, t0 = performance.now(), dur = Math.min(450, 120 + Math.abs(to - from) * 4)
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3
        shown = from + (to - from) * e; val.textContent = fmt(Math.round(shown))
        if (k < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    api.set = (v = 0) => {
      v = +v || 0; const grew = v !== api.value; api.value = v
      if (grew) { val.classList.remove("pop"); void val.offsetWidth; val.classList.add("pop") }
      tween(v); return api
    }
    api.add = (d = 1) => api.set(api.value + (+d || 0))
    api.remove = () => { box.classList.add("kit-out"); later(300, () => box.remove()) }
    api.set(o.value ?? 0); shown = api.value; val.textContent = fmt(api.value)
    return api
  }

  function timer(label = "Time", seconds = 60, onZero) {
    const box = el("div", "kit-count kit-timer kit-glass"), val = el("span", "val")
    box.append(el("span", "lab", label), val); tc.append(box)
    const api = { left: Math.max(0, +seconds || 0), running: true, el: box }
    let last = performance.now(), fired = false
    const draw = () => {
      const s = Math.ceil(api.left)
      val.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
      box.classList.toggle("urgent", api.left > 0 && api.left <= 10)
    }
    const id = setInterval(() => {
      const now = performance.now(), dt = (now - last) / 1000; last = now
      if (!api.running || paused || document.hidden) return
      api.left = Math.max(0, api.left - dt); draw()
      if (api.left <= 0 && !fired) { fired = true; api.running = false; try { onZero?.() } catch (e) { console.error(e) } }
    }, 100)
    timers.add(id)
    api.stop = () => { api.running = false; return api }
    api.start = () => { api.running = true; last = performance.now(); return api }
    api.set = (s = 0) => { api.left = Math.max(0, +s || 0); fired = false; draw(); return api }
    api.add = (s = 0) => api.set(api.left + (+s || 0))
    api.remove = () => { clearInterval(id); timers.delete(id); box.classList.add("kit-out"); later(300, () => box.remove()) }
    draw()
    return api
  }

  // ----- transient text -----
  function banner(text = "", o = {}) {
    if (typeof o === "string") o = { sub: o }
    const dur = Math.max(1, +o.duration || 2.4), b = el("div", "kit-banner"), t = el("div", "t", String(text))
    b.style.setProperty("--c", colorOf(o.color, look.accent)); b.style.setProperty("--d", dur + "s")
    b.append(t); if (o.sub) b.append(el("div", "s", String(o.sub)))
    root.append(b); b.style.zIndex = 2
    return new Promise((res) => { later(dur * 1000, () => { b.remove(); res() }) })
  }
  function toast(text = "", o = {}) {
    const dur = Math.max(1, +o.duration || 2.6), t = el("div", "kit-toast kit-glass", String(text))
    t.style.setProperty("--c", colorOf(o.color, look.accent2)); t.style.setProperty("--d", dur + "s")
    toasts.append(t)
    while (toasts.children.length > 4) toasts.firstChild.remove()
    later(dur * 1000, () => t.remove())
  }
  let promptTimer = 0
  function prompt(text) {
    clearTimeout(promptTimer)
    if (text == null || text === "" || text === false) {
      const old = promptBox.firstChild
      if (old) { promptBox.classList.add("off"); promptTimer = later(250, () => { promptBox.textContent = ""; promptBox.classList.remove("off") }) }
      return
    }
    promptBox.classList.remove("off"); promptBox.textContent = ""
    const d = el("div", "kit-glass"); d.append(...promptNodes(String(text))); promptBox.append(d)
  }

  // ----- full screens -----
  function button(text, cls = "") {
    const b = el("button", "kit-btn " + cls, text); b.type = "button"; return b
  }
  function title(o = {}) {
    if (o == null || typeof o !== "object") o = { name: String(o) }
    titleDone?.(); titleEl?.remove()
    const s = el("div", "kit-screen kit-title")
    for (const [i, c] of [look.accent, look.accent2, look.horizon].entries()) {
      const orb = el("div", "orb"); const sz = 36 + i * 10
      Object.assign(orb.style, { width: sz + "vmax", height: sz + "vmax", background: hex(c), left: [-8, 48, 20][i] + "%", top: [-12, 30, 55][i] + "%", animationDelay: -i * 4 + "s", animationDuration: 12 + i * 4 + "s" })
      s.append(orb)
    }
    s.append(el("h1", "kit-name", o.name ?? "Game"))
    if (o.tagline) s.append(el("div", "kit-tag", String(o.tagline)))
    const controls = Array.isArray(o.controls) ? o.controls : o.controls ? [o.controls] : []
    if (controls.length) { const w = el("div", "kit-ctl"); controls.forEach((c) => w.append(chip(c))); s.append(w) }
    const play = button(o.button ?? "Play"); s.append(play, el("div", "kit-hint", "Enter to start"))
    root.append(s); titleEl = s; sync(); setTimeout(() => play.focus({ preventScroll: true }), 50)
    return new Promise((resolve) => {
      const done = () => {
        if (titleEl !== s) return
        window.removeEventListener("keydown", onKey, true); titleEl = null; titleDone = null; sync(); leave(s); resolve()
      }
      const onKey = (e) => { if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); e.stopPropagation(); done() } }
      titleDone = done
      play.addEventListener("click", done); window.addEventListener("keydown", onKey, true)
    })
  }

  function end(o = {}) {
    if (o == null || typeof o !== "object") o = {}
    const won = !!o.won
    if (paused) api.pause(false)
    endEl?.remove()
    const s = el("div", `kit-screen kit-end ${won ? "win" : "lose"}`)
    if (!won) s.style.setProperty("--a", hex(DANGER))
    if (won) for (let i = 0; i < 36; i++) {
      const c = el("i", "kit-conf"); c.style.left = Math.random() * 100 + "%"
      c.style.background = hex([look.accent, look.accent2, 0xffd34d, 0xffffff][i % 4])
      c.style.setProperty("--t", 3 + Math.random() * 3 + "s"); c.style.setProperty("--w", -Math.random() * 5 + "s")
      s.append(c)
    }
    s.append(el("h1", "kit-name", o.title ?? (won ? "Victory" : "Game over")))
    if (o.subtitle) s.append(el("div", "kit-tag", String(o.subtitle)))
    const stats = o.stats && typeof o.stats === "object" ? Object.entries(o.stats) : []
    if (stats.length) {
      const box = el("div", "kit-stats kit-glass")
      stats.forEach(([k, v], i) => {
        const r = el("div", "kit-stat"); r.style.animationDelay = 0.5 + i * 0.12 + "s"
        r.append(el("span", "", k), el("b", "", fmt(v))); box.append(r)
      })
      s.append(box)
    }
    const again = button(o.button ?? "Play again"); s.append(again)
    root.append(s); endEl = s; sync(); setTimeout(() => again.focus({ preventScroll: true }), 50)
    return new Promise((resolve) => {
      const done = () => {
        if (endEl !== s) return
        window.removeEventListener("keydown", onKey, true); endEl = null; sync(); leave(s); resolve()
      }
      const onKey = (e) => { if (e.code === "Enter") { e.preventDefault(); done() } }
      again.addEventListener("click", done); window.addEventListener("keydown", onKey, true)
    })
  }

  function pause(on = !paused) {
    on = !!on
    if (on === paused) return api
    if (on && (titleEl || endEl)) return api
    paused = on
    if (on) {
      const s = el("div", "kit-screen kit-pause"), card = el("div", "kit-card kit-glass")
      const resume = button("Resume"); resume.addEventListener("click", () => pause(false))
      card.append(el("h1", "kit-name", "Paused"), resume, el("div", "kit-hint", "Esc to resume"))
      s.append(card); root.append(s); pauseEl = s; setTimeout(() => resume.focus({ preventScroll: true }), 50)
    } else if (pauseEl) { leave(pauseEl, 300); pauseEl = null }
    for (const fn of pauseListeners) try { fn(paused) } catch (e) { console.error(e) }
    return api
  }
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Escape" || e.repeat) return
    const t = e.target
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
    pause(!paused)
  })

  const api = {
    root, title, bar, counter, timer, banner, toast, prompt, end, pause,
    get paused() { return paused },
    onPause(fn) { if (typeof fn === "function") pauseListeners.add(fn); return () => pauseListeners.delete(fn) },
    destroy() { timers.forEach(clearInterval); root.remove() },
  }
  return api
}
