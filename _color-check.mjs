/**
 * 颜色契约验证：工作区行（project-row）的标题文字与文件夹图标要对齐官方
 * Rows 的配色语义。
 *
 * 官方依据（Rows.module.css + ProjectRowItem）：
 *   .projectRow           color: var(--dsw-alias-label-primary)   ← 行本身是正文黑
 *   .projectRow .title    无独立 color，继承行 → 正文黑
 *   .slot（folder 槽）     color: var(--dsw-alias-label-tertiary)  ← 图标是灰
 *   .folderActive         color: var(--dsw-alias-state-business-primary) ← 含当前会话转主色
 *
 * 结论：**未激活工作区的标题也是黑的，只有图标是灰的。**
 * 本脚本把这条契约钉死，防止再出现「未激活整行变灰」。
 *
 * 用法：
 *   node _color-check.mjs            断言并退出（退出码非 0 表示契约被破坏）
 *   node _color-check.mjs --dump     打印每个节点的生效 color 与命中规则
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const dump = process.argv.includes('--dump')

/* ══════════════════════════════════════════════════════════════════════════
 * 渲染后端（复用 layout-check.mjs 的做法）
 * ══════════════════════════════════════════════════════════════════════════ */

function tryRequire(name) {
  try { return require(name) } catch { return undefined }
}

const RealReact = tryRequire('react')
const RealServer = tryRequire('react-dom/server')

const FRAGMENT = Symbol('react.fragment')
let currentSlots = null
let slotIndex = 0

function slot(index, create) {
  if (currentSlots === null) return create()
  while (currentSlots.length <= index) currentSlots.push(undefined)
  if (currentSlots[index] === undefined) currentSlots[index] = create()
  return currentSlots[index]
}

const StubReact = {
  Fragment: FRAGMENT,
  version: 'stub',
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true)
    const normalized = { ...(props ?? {}) }
    if (flat.length === 1) normalized.children = flat[0]
    else if (flat.length > 1) normalized.children = flat
    return { $$element: true, type, props: normalized }
  },
  useState(initial) { const i = slotIndex++; return slot(i, () => [typeof initial === 'function' ? initial() : initial, () => {}]) },
  useEffect() { slotIndex++ },
  useMemo(factory) { const i = slotIndex++; return slot(i, () => factory()) },
  useCallback(fn) { const i = slotIndex++; return slot(i, () => fn) },
  useRef(initial) { const i = slotIndex++; return slot(i, () => ({ current: initial ?? null })) },
  useLayoutEffect() { slotIndex++ },
  createContext(defaultValue) {
    return { _default: defaultValue, Provider(props) { return props.children }, Consumer(props) { return props.children(defaultValue) }, displayName: 'Context', __isContext: true, defaultValue }
  },
  useContext(context) { return context?.defaultValue },
  memo(component) { return component },
  forwardRef(fn) { return fn },
}

function renderToTree(element) {
  if (element === null || element === undefined || element === false || element === true) return null
  if (Array.isArray(element)) return element.map(renderToTree).filter(Boolean)
  if (typeof element === 'string' || typeof element === 'number') {
    return { id: `text-${String(textSeq++)}`, tag: '#text', attributes: {}, children: [], text: String(element) }
  }
  if (typeof element !== 'object' || element.$$element !== true) return null

  const { type, props } = element

  if (typeof type === 'function') {
    const savedSlots = currentSlots
    const savedIndex = slotIndex
    currentSlots = []
    slotIndex = 0
    let output
    try {
      output = type(props)
    } finally {
      currentSlots = savedSlots
      slotIndex = savedIndex
    }
    return renderToTree(output)
  }

  if (type === FRAGMENT) return renderToTree(props.children)

  const attributes = {}
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'ref' || key === 'key') continue
    if (value === null || value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') continue
    if (key === 'style') continue
    attributes[key] = value === true ? '' : String(value)
  }
  const node = { id: `el-${String(elementSeq++)}`, tag: String(type), attributes, children: [], parent: null }
  const children = renderToTree(props.children)
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null) continue
    child.parent = node
    node.children.push(child)
  }
  return node
}

let elementSeq = 0
let textSeq = 0

/* ══════════════════════════════════════════════════════════════════════════
 * 选择器匹配（只覆盖插件实际用到的语法子集）
 * ══════════════════════════════════════════════════════════════════════════ */

function parseCompound(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*') return { universal: true, tests: [] }
  const tests = []
  const pattern = /\[([A-Za-z0-9_-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|\.([A-Za-z0-9_-]+)|(?:^|[\s>+])([A-Za-z][A-Za-z0-9-]*)/g
  let match
  while ((match = pattern.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      const [, name, operator, value] = match
      tests.push({ kind: 'attr', name, operator, value: value ?? '' })
    } else if (match[4] !== undefined) {
      tests.push({ kind: 'class', name: match[4] })
    } else if (match[5] !== undefined) {
      tests.push({ kind: 'tag', name: match[5].toLowerCase() })
    }
  }
  return { universal: false, tests }
}

function matchesCompound(node, compound) {
  if (node === null || node.tag === '#text') return false
  if (compound.universal) return true
  for (const test of compound.tests) {
    if (test.kind === 'tag' && node.tag !== test.name) return false
    if (test.kind === 'class') {
      const raw = node.attributes.class ?? node.attributes.className ?? ''
      if (!String(raw).split(/\s+/).includes(test.name)) return false
    }
    if (test.kind === 'attr') {
      if (!(test.name in node.attributes)) return false
      const actual = String(node.attributes[test.name] ?? '')
      if (test.operator === undefined) continue
      if (test.operator === '=' && actual !== test.value) return false
      if (test.operator === '~=' && !actual.split(/\s+/).includes(test.value)) return false
      if (test.operator === '^=' && !actual.startsWith(test.value)) return false
      if (test.operator === '$=' && !actual.endsWith(test.value)) return false
      if (test.operator === '*=' && !actual.includes(test.value)) return false
    }
  }
  return true
}

function parseSelector(selector) {
  const normalized = selector.trim().replace(/\s*([>+~])\s*/g, '$1')
  if (normalized === '') return []
  const tokens = normalized.split(/([>+~])/).filter(token => token !== '' && token !== '~')
  const parts = []
  for (const token of tokens) {
    if (token === '>' || token === '+') { parts.push(token); continue }
    const pieces = token.split(/\s+/).filter(Boolean)
    pieces.forEach((piece, index) => {
      if (index > 0) parts.push(' ')
      parts.push(piece)
    })
  }
  return parts
}

function hasPseudo(selector) {
  return /:(hover|focus|active|focus-visible|not|has|is|where|root|only-child|first-child|last-child|nth-|lang|dir|placeholder|checked|disabled|read-only|any-link|link|visited|target|empty|in-range|out-of-range|required|optional|valid|invalid|default|indeterminate|scope)\b/.test(selector)
}

function querySelectorAll(root, selector) {
  const parts = parseSelector(selector)
  if (parts.length === 0) return []
  const all = []
  const collect = node => {
    if (node !== null && node.tag !== '#text') all.push(node)
    for (const child of node.children ?? []) collect(child)
  }
  collect(root)
  return all.filter(node => matchChain(node, parts, parts.length - 1))
}

/**
 * 从右往左匹配；`parts` 里组合器与被空格分隔的复合选择器交替出现。
 */
function matchChain(node, parts, index) {
  if (index < 0) return true
  const part = parts[index]
  if (part === '>' || part === '+' || part === ' ') {
    // 组合器应在更深一层处理，不单独出现（防御）
    return false
  }
  if (!matchesCompound(node, parseCompound(part))) return false
  if (index === 0) return true
  const combinator = parts[index - 1]
  if (combinator === '>') {
    return node.parent !== null && matchChain(node.parent, parts, index - 2)
  }
  if (combinator === '+') {
    const siblings = node.parent?.children ?? []
    const at = siblings.indexOf(node)
    if (at <= 0) return false
    return matchChain(siblings[at - 1], parts, index - 2)
  }
  if (combinator === ' ') {
    let ancestor = node.parent
    while (ancestor !== null) {
      if (matchChain(ancestor, parts, index - 2)) return true
      ancestor = ancestor.parent
    }
    return false
  }
  // 两个复合选择器直接相邻 = 隐式后代
  let ancestor = node.parent
  while (ancestor !== null) {
    if (matchChain(ancestor, parts, index - 1)) return true
    ancestor = ancestor.parent
  }
  return false
}

/* ══════════════════════════════════════════════════════════════════════════
 * CSS 解析 / 求值
 * ══════════════════════════════════════════════════════════════════════════ */

function parseCssRules(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(css)) !== null) {
    const selectorText = match[1].trim()
    const body = match[2].trim()
    if (selectorText === '' || selectorText.startsWith('@')) continue
    for (const selector of selectorText.split(',')) {
      const trimmed = selector.trim()
      if (trimmed !== '') rules.push({ selector: trimmed, body })
    }
  }
  return rules
}

function specificity(selector) {
  const attrs = (selector.match(/\[[^\]]+\]/g) ?? []).length
  const types = (selector.match(/(^|[\s>+])([a-zA-Z][a-zA-Z0-9-]*)/g) ?? []).length
  return attrs * 100 + types
}

/** 求节点生效的属性：命中规则按（特异性、出现顺序）覆盖。 */
function resolvedProperty(root, node, property, options = {}) {
  const rules = parseCssRules(root.__css ?? '')
  const hits = []
  let order = 0
  for (const rule of rules) {
    order++
    if (hasPseudo(rule.selector)) continue
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(rule.body)
    if (declaration === null) continue
    if (!querySelectorAll(root, rule.selector).includes(node)) continue
    hits.push({ selector: rule.selector, value: declaration[1].trim(), weight: specificity(rule.selector), order })
  }
  hits.sort((a, b) => (a.weight - b.weight) || (a.order - b.order))
  const winner = hits.length === 0 ? undefined : hits[hits.length - 1]
  if (options.withHits) return { winner, hits }
  return winner?.value
}

/** 沿父链求最终 color（只关心继承）。 */
function effectiveColor(root, node) {
  let current = node
  while (current !== null) {
    const own = resolvedProperty(root, current, 'color')
    if (own !== undefined) return { value: own, from: current === node ? 'self' : 'inherited' }
    current = current.parent
  }
  return { value: undefined, from: 'unset' }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 装载插件
 * ══════════════════════════════════════════════════════════════════════════ */

const useReal = RealReact !== undefined && RealServer !== undefined
const React = useReal ? RealReact : StubReact

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory(name => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

const memoryStore = new Map()
globalThis.localStorage = {
  getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => { memoryStore.set(key, value) },
  removeItem: key => { memoryStore.delete(key) },
}

const clientArg = process.argv.slice(2).find(arg => !arg.startsWith('--'))
const source = readFileSync(clientArg ?? join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const M = loaded

/* ── 数据：两个工作区，w1 含当前会话（激活），w2 不含（模拟 prometheus） ── */

const t = key => key
const makeHook = value => selector => (typeof selector === 'function' ? selector(value) : value)

const baseSessions = {
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', title: '激活工作区里的会话', updatedAt: 1000, retainedBy: { mainView: 1 }, blank: false },
    s2: { id: 's2', title: 'prometheus 里的会话', updatedAt: 2000, blank: false },
  },
  phase: 'ready',
  projectionsBySession: {},
}

const baseWorkspaces = {
  items: [
    { workspaceId: 'w1', path: '/p/active', title: 'active-ws', sessionIds: ['s1'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    { workspaceId: 'w2', path: '/p/prometheus', title: 'prometheus', sessionIds: ['s2'], createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
  ],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

function makeProps(overrides = {}) {
  return {
    useSessions: makeHook(overrides.sessions ?? baseSessions),
    useSessionStatus: makeHook(overrides.statuses ?? new Map()),
    useWorkspaces: makeHook(overrides.workspaces ?? baseWorkspaces),
    usePanelInfo: makeHook(overrides.panelInfo ?? { activePanelId: null }),
    config: overrides.config ?? {},
    t: overrides.t ?? t,
    openSession: () => {}, startSession: () => {}, forkSession: () => Promise.resolve(),
    renameSession: () => Promise.resolve(), pinSession: () => Promise.resolve(),
    unpinSession: () => Promise.resolve(), archiveSession: () => Promise.resolve(),
    unarchiveSession: () => Promise.resolve(), renameWorkspace: () => Promise.resolve(),
    deleteWorkspace: () => Promise.resolve(), insertWorkspaceBefore: () => Promise.resolve(),
    createWorkspace: () => Promise.resolve(),
    searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
    searchResultLimit: 20, pickDirectory: () => Promise.resolve(null),
    hostHome: undefined, notify: () => {},
  }
}

function renderTree(props) {
  elementSeq = 0
  textSeq = 0
  let tree
  if (useReal) {
    const html = RealServer.renderToStaticMarkup(React.createElement(M.__FloatingSidebar, props))
    tree = parseHtmlToTree(html)
  } else {
    tree = renderToTree(React.createElement(M.__FloatingSidebar, props))
  }
  tree.__css = M.__buildCss({ ...M.__DEFAULTS, ...(props.config ?? {}) })
  return tree
}

function parseHtmlToTree(html) {
  const root = { id: 'root', tag: '#root', attributes: {}, children: [], parent: null }
  const stack = [root]
  const pattern = /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^<>]*?)?)\/?>|<\/([A-Za-z][A-Za-z0-9-]*)>|([^<]+)/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    const [, openTag, rawAttrs, closeTag, text] = match
    if (openTag !== undefined) {
      const node = { id: `h-${String(elementSeq++)}`, tag: openTag.toLowerCase(), attributes: {}, children: [], parent: null }
      const attrPattern = /([A-Za-z0-9_:@-]+)(?:="([^"]*)")?/g
      let attrMatch
      while ((attrMatch = attrPattern.exec(rawAttrs ?? '')) !== null) {
        node.attributes[attrMatch[1]] = attrMatch[2] ?? ''
      }
      const parent = stack[stack.length - 1]
      node.parent = parent
      parent.children.push(node)
      if (!/\/$/.test(match[0])) stack.push(node)
      continue
    }
    if (closeTag !== undefined) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (text !== undefined && text.trim() !== '') {
      const parent = stack[stack.length - 1]
      parent.children.push({ id: `t-${String(textSeq++)}`, tag: '#text', attributes: {}, children: [], parent, text })
    }
  }
  return root
}

function find(node, predicate, out = []) {
  if (predicate(node)) out.push(node)
  for (const child of node.children) find(child, predicate, out)
  return out
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

const tree = renderTree(makeProps())
const rows = find(tree, node => node.attributes['data-dsh-fso-project-row'] !== undefined)

console.log(`\n渲染后端：${useReal ? `官方 react ${RealReact.version ?? '?'} + react-dom/server` : '内置 React 桩'}`)
console.log(`工作区行数量：${String(rows.length)}`)

const isActive = row => {
  const folder = find(row, n => n.attributes['data-dsh-fso-folder'] !== undefined)[0]
  return folder !== undefined && 'data-active' in folder.attributes
}

if (dump) {
  for (const row of rows) {
    const title = find(row, n => n.attributes['data-dsh-fso-title'] !== undefined)[0]
    const folder = find(row, n => n.attributes['data-dsh-fso-folder'] !== undefined)[0]
    const label = title === undefined ? '?' : find(title, n => n.tag === '#text').map(n => n.text).join('')
    console.log(`\n── 行「${label}」 active=${String(isActive(row))}`)
    for (const [name, node] of [['row', row], ['title', title], ['folder', folder]]) {
      if (node === undefined) continue
      const result = resolvedProperty(tree, node, 'color', { withHits: true })
      const effective = effectiveColor(tree, node)
      console.log(`   ${name}: 生效=${effective.value ?? '(无)'} [${effective.from}]`)
      for (const hit of result.hits) console.log(`      · ${hit.selector} → ${hit.value} (w=${String(hit.weight)}, #${String(hit.order)})`)
      if (result.hits.length === 0) console.log('      · (无规则直接命中，颜色来自继承)')
    }
  }
  console.log('')
}

console.log('\n=== 配色契约 ===')

/* [1] 行本身是正文黑（官方 .projectRow color: label-primary）。 */
{
  const rowColors = rows.map(row => resolvedProperty(tree, row, 'color'))
  check('[1] 工作区行 color = label-primary（正文黑）',
    rowColors.length > 0 && rowColors.every(value => value === 'var(--dsw-alias-label-primary)'),
    JSON.stringify(rowColors))
}

/* [2] 存在未激活工作区，标题必须是黑的（继承行），不得被改成灰。 */
{
  const inactive = rows.filter(row => !isActive(row))
  check('[2] 存在未激活工作区行（复现 prometheus 场景）', inactive.length >= 1, `count=${String(inactive.length)}`)

  const titleColors = inactive.map(row => effectiveColor(tree, find(row, n => n.attributes['data-dsh-fso-title'] !== undefined)[0]))
  check('[3] 未激活工作区标题 = label-primary（黑），不是灰',
    titleColors.length > 0 && titleColors.every(result => result.value === 'var(--dsw-alias-label-primary)'),
    JSON.stringify(titleColors.map(r => `${String(r.value)}[${r.from}]`)))

  /* 图标与标题一致为正文黑：未激活工作区不该看起来像「被禁用」。 */
  const folderColors = inactive.map(row => effectiveColor(tree, find(row, n => n.attributes['data-dsh-fso-folder'] !== undefined)[0]))
  check('[4] 未激活工作区图标 = label-primary（黑，与标题一致）',
    folderColors.length > 0 && folderColors.every(result => result.value === 'var(--dsw-alias-label-primary)'),
    JSON.stringify(folderColors.map(r => `${String(r.value)}[${r.from}]`)))
}

/* [3] 激活工作区：图标主色，标题仍黑。 */
{
  const active = rows.filter(isActive)
  check('[5] 存在激活的工作区行', active.length >= 1, `count=${String(active.length)}`)

  const folderColors = active.map(row => effectiveColor(tree, find(row, n => n.attributes['data-dsh-fso-folder'] !== undefined)[0]))
  check('[6] 激活工作区图标 = state-business-primary（主色）',
    folderColors.length > 0 && folderColors.every(result => result.value === 'var(--dsw-alias-state-business-primary)'),
    JSON.stringify(folderColors.map(r => String(r.value))))

  const titleColors = active.map(row => effectiveColor(tree, find(row, n => n.attributes['data-dsh-fso-title'] !== undefined)[0]))
  check('[7] 激活工作区标题同样是 label-primary（黑）',
    titleColors.length > 0 && titleColors.every(result => result.value === 'var(--dsw-alias-label-primary)'),
    JSON.stringify(titleColors.map(r => String(r.value))))
}

/* [4] 每个图标槽都要么是 tertiary（默认），要么在激活工作区的 folder 上是主色。
 *     注意不能直接对 `slots[0]` 取色：第一个槽可能正是激活行的 folder
 *     （folderActive 覆盖了 .slot 的 tertiary），那是正确行为。 */
{
  const slots = find(tree, node => node.attributes['data-dsh-fso-slot'] !== undefined)
  const folderSlots = slots.filter(node => 'data-dsh-fso-folder' in node.attributes)
  const plainSlots = slots.filter(node => !('data-dsh-fso-folder' in node.attributes) && !('data-dsh-fso-chevron' in node.attributes))

  const plainColors = plainSlots.map(node => resolvedProperty(tree, node, 'color'))
  check('[8] 普通图标槽 base 色 = label-tertiary（官方 .slot）',
    plainColors.length > 0 && plainColors.every(value => value === 'var(--dsw-alias-label-tertiary)'),
    JSON.stringify(plainColors))

  /* folder 槽只允许两种取值：未激活=正文黑，激活=主色。绝不能再落回 tertiary 灰。 */
  const folderColors = folderSlots.map(node => resolvedProperty(tree, node, 'color'))
  check('[8b] folder 槽取值只有「正文黑 / 主色」两种，不落回 tertiary 灰',
    folderColors.length > 0 && folderColors.every(value =>
      value === 'var(--dsw-alias-label-primary)' || value === 'var(--dsw-alias-state-business-primary)'),
    JSON.stringify(folderColors))
}

/* [5] 未归档会话行标题是黑的。 */
{
  const sessionTitles = find(tree, node => node.attributes['data-dsh-fso-session-row'] !== undefined && node.attributes['data-archived'] === undefined)
    .map(row => find(row, n => n.attributes['data-dsh-fso-title'] !== undefined)[0])
    .filter(Boolean)
  const colors = sessionTitles.map(node => effectiveColor(tree, node))
  check('[9] 未归档会话行标题 = label-primary（黑）',
    colors.length > 0 && colors.every(result => result.value === 'var(--dsw-alias-label-primary)'),
    JSON.stringify(colors.map(r => String(r.value))))
}

/* [6] 归档行才转 caption。
 *     归档筛选默认是 `default`（隐藏归档），所以必须显式设成 `show`
 *     才能渲染出归档行。 */
{
  const archivedTree = renderTree(makeProps({
    config: { archivedFilter: 'show' },
    workspaces: { ...baseWorkspaces, archivedSessionIds: ['s1', 's2'] },
  }))
  const archivedRows = find(archivedTree, node => node.attributes['data-dsh-fso-session-row'] !== undefined)
  const archivedOnes = archivedRows.filter(node => node.attributes['data-archived'] !== undefined)
  const colors = archivedOnes
    .map(row => find(row, n => n.attributes['data-dsh-fso-title'] !== undefined)[0])
    .filter(Boolean)
    .map(node => effectiveColor(archivedTree, node))
  check('[10] 归档会话标题 = label-caption（只有归档才灰）',
    colors.length > 0 && colors.every(result => result.value === 'var(--dsw-alias-label-caption)'),
    `archivedRows=${String(archivedOnes.length)} colors=${JSON.stringify(colors.map(r => String(r.value)))}`)
}

console.log(`\n通过 ${String(pass)} 项${failures.length === 0 ? '，全部符合契约' : `，失败 ${String(failures.length)} 项`}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const name of failures) console.log(`  · ${name}`)
  process.exitCode = 1
}
