/**
 * 鼠标触发闪烁的确定性复现（不依赖真实浏览器）。
 *
 * ── 为什么要这个脚本 ───────────────────────────────────────────────────────
 * `repro-flicker.mjs` / `repro-flicker2.mjs` 走 headless Chrome，只能验证
 * **纯 CSS**（transform / opacity 过渡）本身闪不闪。它们把开关写成
 * `html[data-dsh-fso-open]` 手动切换，**绕过了 apply 里的指针状态机**。
 *
 * 但真机上「鼠标触发时闪烁抽搐」的根因就在那个状态机里：
 *
 *   onMove（已打开分支）：
 *     const outside = event.clientX > cardRect.right + slack || ...
 *     if (outside) setOpen(false)
 *
 *   而 `cardRect` 来自 `card.getBoundingClientRect()` —— 在 180ms 的滑入动画
 *   **期间**读到的右边界是**动画中间位置**，不是布局位置。卡片宽度 280、
 *   `translateX(-110%)` 时右边界是负数。
 *
 *   于是：指针停在左边缘热区（clientX ≤ 24）→ 热区命中 → 打开 →
 *   下一帧量到 right + slack < 0 → 判定「已经在卡片外」→ 立刻收回 →
 *   指针仍在热区 → 再次打开 ……  每帧一次，视觉上就是高频抽搐。
 *
 * 本脚本用一个**自建的最小浏览器模型**（虚拟时钟 + 与 CSS 一致的过渡插值
 * + 与真实 DOM 同语义的 `getBoundingClientRect`）真实执行 `apply`，把这条
 * 振荡逐帧记录下来，并在修复后断言振荡消失。
 *
 * ── 模型与真实浏览器的对应关系 ────────────────────────────────────────────
 *   · 指针事件：按 pointerrawupdate 的典型频率 120Hz（每 8ms）派发；
 *   · rAF：60Hz（每 16.67ms），与真实显示器一致（指针事件远密于帧）；
 *   · 卡片过渡：`cubic-bezier(.32,.72,0,1)` 180ms，由本地 cubic-bezier
 *     求值实现，与 CSS 引擎同一套数学；
 *   · `getBoundingClientRect()`：返回**受 transform 影响的视觉矩形**
 *     （如浏览器所为，会随动画逐帧变化）；
 *   · 样式/布局/动画在同一帧内同步结算，这一点与浏览器相同。
 *
 * 运行：node repro-hover-flicker.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ══════════════════════════════════════════════════════════════════════════
 * 几何常量：与 DEFAULTS / buildCss 保持一致
 * ══════════════════════════════════════════════════════════════════════════ */

const GAP = 8
const CARD_W = 280
const CARD_LEFT = GAP              // panel padding = gap
const CARD_RIGHT = GAP + CARD_W    // = 288
const TRIGGER = 24                 // config.trigger
const SLACK = 8                    // config.closeSlack
const TITLEBAR = 40                // --dsh-fso-top
const ANIM_MS = 180
/** translateX(-110%)：百分比相对元素自身宽度。 */
const CLOSED_TX = -1.1 * CARD_W

/* ══════════════════════════════════════════════════════════════════════════
 * cubic-bezier(.32,.72,0,1) 求值（Newton + 二分兜底）
 * ══════════════════════════════════════════════════════════════════════════ */

function bezier(x1, y1, x2, y2) {
  const a = (p1, p2) => 1 - 3 * p2 + 3 * p1
  const b = (p1, p2) => 3 * p2 - 6 * p1
  const c = p1 => 3 * p1
  const calc = (t, p1, p2) => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t
  const slope = (t, p1, p2) => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1)
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const error = calc(t, x1, x2) - x
      if (Math.abs(error) < 1e-6) return calc(t, y1, y2)
      const d = slope(t, x1, x2)
      if (Math.abs(d) < 1e-6) break
      t -= error / d
    }
    let lo = 0
    let hi = 1
    for (let i = 0; i < 40; i++) {
      t = (lo + hi) / 2
      if (calc(t, x1, x2) < x) lo = t
      else hi = t
    }
    return calc(t, y1, y2)
  }
}

const ease = bezier(0.32, 0.72, 0, 1)

/* ══════════════════════════════════════════════════════════════════════════
 * 虚拟时钟
 * ══════════════════════════════════════════════════════════════════════════ */

const rafQueue = []
let clock = 0

globalThis.requestAnimationFrame = (fn) => {
  rafQueue.push(fn)
  return rafQueue.length
}
globalThis.cancelAnimationFrame = (handle) => {
  const index = handle - 1
  if (index >= 0 && index < rafQueue.length) rafQueue[index] = null
}

/** 推进一帧：先跑 rAF 回调（帧末，与浏览器一致），再让时钟前进。 */
function frame(dt) {
  const due = rafQueue.splice(0, rafQueue.length)
  for (const fn of due) if (typeof fn === 'function') fn(clock)
  clock += dt
}

/* ══════════════════════════════════════════════════════════════════════════
 * 卡片模型：几何 + 过渡插值 + 视觉矩形
 * ══════════════════════════════════════════════════════════════════════════ */

const card = {
  /** 当前 `data-open` 属性是否存在。 */
  open: false,
  /** 过渡起始时刻与起始位移。 */
  from: 0,
  fromTx: CLOSED_TX,
  /** 是否正在过渡。 */
  animating: false,

  setOpenFlag(next) {
    if (next === this.open) return
    this.from = clock
    this.fromTx = this.currentTx()
    this.open = next
    this.animating = true
  },

  /** 动画进度 0..1（线性时间），再套 easing。 */
  currentTx() {
    if (!this.animating) return this.open ? 0 : CLOSED_TX
    const raw = Math.min(1, (clock - this.from) / ANIM_MS)
    const eased = ease(raw)
    const to = this.open ? 0 : CLOSED_TX
    return this.fromTx + (to - this.fromTx) * eased
  },

  settle() {
    if (this.animating && clock - this.from >= ANIM_MS) this.animating = false
  },

  /** 与浏览器同语义：返回**视觉**矩形（含 transform）。 */
  getBoundingClientRect() {
    this.settle()
    const left = CARD_LEFT + this.currentTx()
    return {
      left,
      right: left + CARD_W,
      top: TITLEBAR,
      bottom: 900,
      width: CARD_W,
      height: 900 - TITLEBAR,
      x: left,
      y: TITLEBAR,
    }
  },

  setAttribute(name) { if (name === 'data-open') this.setOpenFlag(true) },
  removeAttribute(name) { if (name === 'data-open') this.setOpenFlag(false) },
  hasAttribute(name) { return name === 'data-open' ? this.open : false },
  getAttribute(name) { return name === 'data-open' ? (this.open ? '' : null) : null },
}

/* ══════════════════════════════════════════════════════════════════════════
 * DOM 桩
 * ══════════════════════════════════════════════════════════════════════════ */

const frameEl = {
  attributes: new Map([['class', 'BynINW_frame'], ['data-sidebar-collapsed', 'true']]),
  hasAttribute: (name) => frameEl.attributes.has(name),
  getAttribute: (name) => frameEl.attributes.get(name) ?? null,
}

/**
 * panel 是卡片外面的定位容器，**自身没有 transform**，所以它的矩形是稳定的
 * 布局矩形。这正是修复所依赖的性质：判定与动画相位解耦。
 */
const panel = {
  getBoundingClientRect: () => ({
    left: 0,
    right: CARD_RIGHT + GAP,   // = 296（width + gap*2）
    top: 0,
    bottom: 900,
    width: CARD_RIGHT + GAP,
    height: 900,
    x: 0,
    y: 0,
  }),
}

const docListeners = new Map()
const documentStub = {
  documentElement: {
    style: {
      props: new Map(),
      setProperty(k, v) { this.props.set(k, v) },
      getPropertyValue(k) { return this.props.get(k) ?? '' },
      removeProperty(k) { this.props.delete(k) },
    },
    attributes: new Map(),
    hasAttribute(name) { return this.attributes.has(name) },
    getAttribute(name) { return this.attributes.get(name) ?? null },
    setAttribute(name, value) { this.attributes.set(name, String(value)) },
    removeAttribute(name) { this.attributes.delete(name) },
  },
  head: { children: [], appendChild(child) { this.children.push(child); return child } },
  body: { children: [], appendChild(child) { this.children.push(child); return child } },
  createElement: () => ({ style: { cssText: '', setProperty() {}, removeProperty() {} }, appendChild() {}, remove() {}, setAttribute() {}, textContent: '' }),
  querySelector: (selector) => {
    // 修复后的实现量 panel（布局矩形）；旧实现量 card（视觉矩形，会抖动）。
    if (selector === '[data-dsh-fso-panel]') return panel
    if (selector === '[data-dsh-fso-card]') return card
    if (String(selector).includes('_frame')) return frameEl
    return null
  },
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, new Set())
    docListeners.get(type).add(fn)
  },
  removeEventListener: (type, fn) => { docListeners.get(type)?.delete(fn) },
}

const winListeners = new Map()
function dispatchWin(type, event) {
  for (const fn of winListeners.get(type) ?? []) fn(event)
}

function dispatch(type, event) {
  for (const fn of docListeners.get(type) ?? []) fn(event)
}

globalThis.document = documentStub
globalThis.window = {
  innerHeight: 900,
  setTimeout: () => 0,
  clearTimeout: () => {},
  matchMedia: () => ({ matches: false }),
  addEventListener: (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, new Set())
    winListeners.get(type).add(fn)
  },
  removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn) },
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name === '--dsh-frame-top-clearance' ? '40px' : '') })
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
  setItem(k, v) { this.store.set(k, v) },
  removeItem(k) { this.store.delete(k) },
}
globalThis.AbortController = class { constructor() { this.signal = { aborted: false } } abort() { this.signal.aborted = true } }

/* ══════════════════════════════════════════════════════════════════════════
 * 载入插件
 * ══════════════════════════════════════════════════════════════════════════ */

let loaded
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    loaded = factory(name => {
      if (name === 'react') {
        return {
          createElement: () => null, Fragment: Symbol('f'),
          useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
          useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f,
          useRef: () => ({ current: null }),
        }
      }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

const source = readFileSync(process.argv[2] ?? join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

/* ══════════════════════════════════════════════════════════════════════════
 * 驱动：把指针停在热区内的某个 x，观察卡片是否振荡
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {number|((t:number)=>number)} hover - 指针位置（固定值或随时间变化）。
 * @param {number} ms - 观察时长。
 * @param {number} [trigger] - 热区宽度（px）；默认用 TRIGGER(24)。
 *   热区扩大后会出现「热区比卡片还宽」的新几何，需要单独场景验证。
 * @returns {{transitions: object[], toggles: number, settledAt: number|null}}
 */
function simulate(hover, ms = 600, trigger = TRIGGER) {
  // 每个场景用全新的插件实例（apply 会注册全局监听，先清空）。
  docListeners.clear()
  winListeners.clear()
  rafQueue.length = 0
  clock = 0
  card.open = false
  card.animating = false
  card.from = 0
  card.fromTx = CLOSED_TX
  documentStub.documentElement.style.props.clear()

  const effects = []
  const services = new Map([['slots', {
    inject: (key, cb) => cb(),
    register: (options, component) => { void options; void component; return () => {} },
  }]])
  const ctx = {
    get: (name) => services.get(name),
    effect: (cb) => { const dispose = cb(); effects.push(dispose); return () => {} },
    // 只执行本场景关心的 inject（locale / shortcuts 与本问题无关）。
    inject: (names, cb) => { if (names.includes('slots')) cb(ctx); return () => {} },
  }
  // 真实 Cordis 把服务同时暴露为 `ctx.<name>` 属性。
  for (const [name, service] of services) ctx[name] = service
  loaded.apply(ctx, { trigger, closeSlack: SLACK, onlyWhenCollapsed: true, animationMs: ANIM_MS, debug: false })

  const transitions = []
  let previouslyOpen = card.open
  let settledAt = null
  let openCount = 0

  const pointerStep = 8      // 120Hz 指针事件
  const frameStep = 1000 / 60

  let nextPointer = 0
  let nextFrame = 0

  while (clock < ms) {
    // 先派发本时刻的指针事件（真实浏览器里指针事件比帧密）。
    while (nextPointer <= clock) {
      const x = typeof hover === 'function' ? hover(clock) : hover
      dispatch('pointermove', { clientX: x, clientY: 400 })
      nextPointer += pointerStep
    }
    // 再推进一帧。
    frame(frameStep)
    // 动画结算：真实浏览器里由合成器在过渡结束时完成，与是否有人量矩形无关。
    card.settle()
    nextFrame += frameStep

    if (card.open !== previouslyOpen) {
      openCount += 1
      transitions.push({
        t: Math.round(clock),
        to: card.open,
        tx: Math.round(card.currentTx()),
        visualRight: Math.round(CARD_LEFT + card.currentTx() + CARD_W),
      })
      previouslyOpen = card.open
    }
    // 记录稳态时刻：打开且动画结束。
    if (settledAt === null && card.open && !card.animating) settledAt = Math.round(clock)
    void nextFrame
  }

  return { transitions, toggles: openCount, settledAt, finalOpen: card.open }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 断言
 * ══════════════════════════════════════════════════════════════════════════ */

let pass = 0
const failures = []
function check(name, condition, detail) {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

console.log('\n=== 场景 A：指针停在热区最左（clientX = 1）===')
const a = simulate(1)
console.log('  开合序列: ' + (a.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  开合次数: ${a.toggles}，进入稳态: ${a.settledAt === null ? '从未' : `${a.settledAt}ms`}`)

console.log('\n=== 场景 B：指针停在热区右缘（clientX = 24）===')
const b = simulate(24)
console.log('  开合序列: ' + (b.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  开合次数: ${b.toggles}，进入稳态: ${b.settledAt === null ? '从未' : `${b.settledAt}ms`}`)

/* 场景 C：指针进入热区并停留，随后（动画期间）移到卡片外 —— 必须收起。
 * 这一条防止把修复做成「永不收起」。注意移出时刻落在动画**进行中**，
 * 正是旧实现会误判的那个窗口。 */
console.log('\n=== 场景 C：停 60ms 后移出卡片（动画进行中移出）===')
const c = simulate(t => (t < 60 ? 1 : 900), 600)
console.log('  开合序列: ' + (c.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  最终状态: ${c.finalOpen ? '打开' : '已收起'}`)

/* 场景 D：指针只在热区内移动，全程不进入卡片 —— 也不应收起（热区算作打开区域）。
 * 这是「热区与卡片之间的 8px 缝」：旧实现会因为 x < card.left 误判为离开。 */
console.log('\n=== 场景 D：指针停在热区与卡片之间的缝（clientX = 4）===')
const d = simulate(4, 600)
console.log('  开合序列: ' + (d.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  开合次数: ${d.toggles}，最终状态: ${d.finalOpen ? '打开' : '已收起'}`)

/* 场景 E/F：**热区比卡片宽**的几何。
 *
 * 这是「热区按留白比例扩大」才引入的场景：旧热区固定 24px，永远落在
 * 卡片（8..288）之内，所以「指针在热区内 / 在卡片内」几乎等价。按比例算之后
 * 热区可以超过卡片右缘 288，于是出现两类新情况，都必须验证：
 *   E. 指针停在「卡片右缘之外、热区之内」→ 必须保持打开（热区算作打开区域），
 *      否则会每帧开合；
 *   F. 指针停在「热区之外」→ 必须收起。
 *
 * ⚠ 比例是 0.4，所以「热区 > 288」需要窗口足够宽：
 *     热区 = ceil((视口 − min(视口, clamp(680,视口×.64,920))) / 2 × 0.4)
 *   实测阈值约 2361px —— 1920px 窗口只有 200（仍在卡片内），
 *   所以这里取 3000px 窗口 → 热区 416（> 288），场景才成立。 */
const WIDE_TRIGGER = 416   // 3000px 窗口、ratio 0.4 下的热区
console.log(`\n=== 场景 E：热区（${WIDE_TRIGGER}）比卡片（8..288）更宽，指针停在 x=320 ===`)
const e = simulate(320, 600, WIDE_TRIGGER)
console.log('  开合序列: ' + (e.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  开合次数: ${e.toggles}，最终状态: ${e.finalOpen ? '打开' : '已收起'}`)

console.log(`\n=== 场景 F：热区（${WIDE_TRIGGER}）外侧 x=600 ===`)
const f = simulate(t => (t < 40 ? 320 : 600), 600, WIDE_TRIGGER)
console.log('  开合序列: ' + (f.transitions.map(t => `${t.to ? '开' : '关'}@${t.t}ms`).join(' → ') || '（无）'))
console.log(`  最终状态: ${f.finalOpen ? '打开' : '已收起'}`)

console.log('\n=== 断言 ===')
check('[1] 场景 A：进入热区后只发生一次状态切换（开）',
  a.toggles === 1, `实际 ${a.toggles} 次：${a.transitions.map(t => (t.to ? '开' : '关')).join('')}`)
check('[2] 场景 A：卡片能进入稳态（动画跑完且保持打开）',
  a.settledAt !== null, a.settledAt === null ? '从未稳定' : String(a.settledAt))
check('[3] 场景 B：进入热区后只发生一次状态切换（开）',
  b.toggles === 1, `实际 ${b.toggles} 次：${b.transitions.map(t => (t.to ? '开' : '关')).join('')}`)
check('[4] 场景 B：卡片能进入稳态（动画跑完且保持打开）',
  b.settledAt !== null, b.settledAt === null ? '从未稳定' : String(b.settledAt))
check('[5] 场景 A：打开后不再被误判为「在卡片外」',
  !a.transitions.some(t => t.to === false), JSON.stringify(a.transitions))
check('[6] 场景 B：打开后不再被误判为「在卡片外」',
  !b.transitions.some(t => t.to === false), JSON.stringify(b.transitions))

// 反向断言：修复不能以「永不收起」为代价。
check('[7] 场景 C：指针移出卡片后确实收起',
  c.finalOpen === false, `最终 ${c.finalOpen ? '仍打开' : '已收起'}`)
check('[8] 场景 C：收起只发生一次（不振荡）',
  c.toggles === 2, `实际 ${c.toggles} 次：${c.transitions.map(t => (t.to ? '开' : '关')).join('')}`)
check('[9] 场景 D：热区与卡片之间的缝不算「离开」',
  d.finalOpen === true, `最终 ${d.finalOpen ? '打开' : '误收起'}`)
check('[10] 场景 D：缝里停留不产生振荡',
  d.toggles === 1, `实际 ${d.toggles} 次：${d.transitions.map(t => (t.to ? '开' : '关')).join('')}`)

/* 热区扩大后新引入的几何（热区比卡片宽）—— 这两条在旧实现上无意义
 * （旧热区 24px 永远在卡片内），是本次改动必须新增的回归。 */
check('[11] 场景 E：热区比卡片宽时，指针停在卡片右缘之外仍保持打开',
  e.finalOpen === true, `最终 ${e.finalOpen ? '打开' : '误收起'}`)
check('[12] 场景 E：该位置不产生振荡',
  e.toggles === 1, `实际 ${e.toggles} 次：${e.transitions.map(t => (t.to ? '开' : '关')).join('')}`)
check('[13] 场景 F：热区之外（x=600 > 416）确实收起',
  f.finalOpen === false, `最终 ${f.finalOpen ? '仍打开' : '已收起'}`)
check('[14] 场景 F：收起只发生一次（不振荡）',
  f.toggles === 2, `实际 ${f.toggles} 次：${f.transitions.map(t => (t.to ? '开' : '关')).join('')}`)

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  console.log('\n结论：指针停在热区内会让卡片每帧开合一次 —— 这就是真机上的「闪烁抽搐」。')
  process.exitCode = 1
} else {
  console.log('全部通过 ✓（指针停在热区内时卡片稳定打开）')
}
