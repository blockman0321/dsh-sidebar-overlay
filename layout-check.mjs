/**
 * 行间距（以及其它「CSS 选择器 vs DOM 结构」契约）的回归验证。
 *
 * ── 为什么需要这个脚本 ─────────────────────────────────────────────────────
 * 症状：相邻两个会话行都显示背景（一个选中、一个 hover）时，两块背景上下
 * 粘连、中间没有间隔。原侧边栏是有 2px 间距的。
 *
 * 根因不是配色也不是行高，而是一条**静默失效**的 CSS 规则：
 *
 *   [data-dsh-fso-list-area] > * > * + * { margin-top: 2px }
 *
 * 插件 DOM 是 list-area → tree-body → list-scroll 的**单链**，而相邻兄弟
 * 选择器要求左侧存在兄弟元素 —— list-scroll 根本没有兄弟，于是这条规则
 * 一个元素都匹配不到，行间距全程为 0。
 *
 * 这类 bug 有个共同特点：**不会报错、不会崩、DOM 也完全正确**，只是样式
 * 匹配不上。于是四套现有测试全部漏过：
 *   · test.mjs        只断言 CSS 文本里有没有某些字符串；
 *   · smoke.mjs       只断言 DOM 里有没有某些属性；
 *   · apply-check.mjs 只断言接线；
 *   · visual-check.mjs 需要浏览器（本机沙箱下会 SKIP）。
 * 没有任何一套把 **CSS 选择器** 和 **真实 DOM 树** 对起来看。
 *
 * 本脚本补上这一环：把生成的 CSS 解析成规则，用一个小型选择器匹配器，
 * 在真实渲染出的 DOM 树上求值，直接断言「本应命中间距规则的相邻行确实
 * 命中了」以及「规则没有落到错误的目标上」。
 *
 * 运行：node layout-check.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/* ══════════════════════════════════════════════════════════════════════════
 * 渲染后端：与 smoke.mjs 一致（优先官方 react-dom/server）
 * ══════════════════════════════════════════════════════════════════════════ */

function tryRequire(name) {
  try { return require(name) } catch { return undefined }
}

const RealReact = tryRequire('react')
const RealServer = tryRequire('react-dom/server')

const FRAGMENT = Symbol('react.fragment')
let currentSlots = null
let slotIndex = 0
const hookViolations = []

function slot(index, create) {
  if (currentSlots === null) { hookViolations.push('在组件外调用了 hook'); return create() }
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
  useReducer() { throw new Error('not implemented') },
  createContext(defaultValue) {
    return {
      _default: defaultValue,
      Provider(props) { return props.children },
      Consumer(props) { return props.children(defaultValue) },
      displayName: 'Context',
      __isContext: true,
      defaultValue,
    }
  },
  useContext(context) {
    // 插件内部只用自己的 context（若有），返回 defaultValue 足够。
    return context?.defaultValue
  },
  memo(component) { return component },
  forwardRef(fn) { return fn },
}

/**
 * 桩渲染 → 真实 DOM 树节点。
 *
 * 与 smoke.mjs 直接拼 HTML 不同，这里必须保留**树结构**，因为本脚本要验证
 * 的正是「选择器能不能沿父子/兄弟关系命中」。
 */
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
    // 每个组件实例一套独立槽位（与 smoke.mjs 一致）；设成 null 会让每次
    // hook 都误报「在组件外调用」。
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

  // 宿主元素。
  const attributes = {}
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'ref' || key === 'key') continue
    if (value === null || value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') continue
    if (key === 'style') continue
    attributes[key] = value === true ? '' : String(value)
  }
  const node = {
    id: `el-${String(elementSeq++)}`,
    tag: String(type),
    attributes,
    children: [],
    parent: null,
  }
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
 * 极小 CSS 解析 + 选择器匹配
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 极简选择器匹配器。
 *
 * 只支持本插件实际用到的语法子集：
 *   · 复合选择器：[attr]、[attr="v"]、标签名、.class、role 等属性；
 *   · 组合器：后代（空格）、子代（>）、相邻兄弟（+）；
 *   · 选择器列表：逗号分隔（任一命中即算命中）。
 *
 * 刻意**不支持**伪类/伪元素（:hover 等）——那些不影响间距契约，遇到就跳过。
 */

/** 解析单个复合选择器（不含组合器）。 */
function parseCompound(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*') return { universal: true, tests: [] }
  const tests = []
  // 依次抓取 [attr]、[attr="value"]、.class、tag。
  // 结构伪类（:first-child 等）不参与属性求值，遇到即跳过（由 hasPseudo 决定
  // 整条规则是否忽略）。标签名必须排除 `>` `+` `~` 等组合器字符。
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

/** 节点是否满足单个复合选择器。 */
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

/**
 * 把一条选择器拆成 [复合, 组合器, 复合, ...]。
 *
 * 实现要点：先把 `>` / `+` / `~` 两侧的**排版空白**去掉，再按组合器切分。
 * 否则 `a > b` 里的空格会被当成后代组合器，解析出四个 token（自检专门
 * 覆盖这一点——解析器自己出错，后面关于插件 DOM 的结论就全不可信了）。
 */
function parseSelector(selector) {
  const normalized = selector.trim().replace(/\s*([>+~])\s*/g, '$1')
  if (normalized === '') return []
  const tokens = normalized.split(/([>+~])/).filter(token => token !== '' && token !== '~')
  const parts = []
  for (const token of tokens) {
    if (token === '>' || token === '+') {
      parts.push(token)
      continue
    }
    // 片段内若还有空白，说明这里才是真正的后代组合器。
    const pieces = token.split(/\s+/).filter(Boolean)
    pieces.forEach((piece, index) => {
      if (index > 0) parts.push(' ')
      parts.push(piece)
    })
  }
  return parts
}

/** 选择器是否含伪类/伪元素（本脚本不模拟，跳过）。 */
function hasPseudo(selector) {
  return /:(hover|focus|active|focus-visible|not|has|is|where|root|only-child|first-child|last-child|nth-|lang|dir|placeholder|checked|disabled|read-only|any-link|link|visited|target|empty|in-range|out-of-range|required|optional|valid|invalid|default|indeterminate|scope)\b/.test(selector)
}

/**
 * 在树上求值一条选择器，返回命中的节点数组。
 * @param {object} root
 * @param {string} selector
 */
function querySelectorAll(root, selector) {
  const all = []
  const collect = node => {
    all.push(node)
    for (const child of node.children) collect(child)
  }
  collect(root)

  const parts = parseSelector(selector)
  if (parts.length === 0) return []
  const compounds = []
  const combinators = []       // combinators[i] 连接 compounds[i] 与 compounds[i+1]
  for (const part of parts) {
    if (part === '>' || part === '+' || part === ' ') {
      if (compounds.length > 0) combinators.push(part)
      continue
    }
    compounds.push(parseCompound(part))
  }
  if (compounds.length === 0) return []
  // 复合选择器数量应恰好比组合器多 1；不一致说明解析出错，宁可返回空集也不要误判。
  if (combinators.length !== compounds.length - 1) return []

  const results = []
  for (const node of all) {
    if (matchesFrom(node, compounds, combinators, compounds.length - 1)) results.push(node)
  }
  return results
}

/**
 * 从最右（`index`）向左递归匹配。
 * @param {object} node - 当前候选节点。
 * @param {object[]} compounds
 * @param {string[]} combinators - combinators[i] 是 compounds[i] 与 compounds[i+1] 之间的关系。
 * @param {number} index
 */
function matchesFrom(node, compounds, combinators, index) {
  if (!matchesCompound(node, compounds[index])) return false
  if (index === 0) return true
  const combinator = combinators[index - 1]
  const parent = node.parent
  if (combinator === '>') {
    return parent !== null && matchesFrom(parent, compounds, combinators, index - 1)
  }
  if (combinator === '+') {
    if (parent === null) return false
    const siblings = parent.children
    const position = siblings.indexOf(node)
    if (position <= 0) return false
    return matchesFrom(siblings[position - 1], compounds, combinators, index - 1)
  }
  // 后代：沿祖先链试探。
  let ancestor = parent
  while (ancestor !== null) {
    if (matchesFrom(ancestor, compounds, combinators, index - 1)) return true
    ancestor = ancestor.parent
  }
  return false
}

/** 解析 CSS 文本 → [{ selector, body }]（跳过 at-rule 与注释）。 */
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

/**
 * 求某个节点最终生效的某条属性：按规则出现顺序，后出现的覆盖先出现的
 * （忽略 !important，本插件明确不用；也忽略特异性——本脚本只关心
 * 「有没有规则命中」，对当前这组单属性选择器足够）。
 */
function resolvedProperty(root, node, property) {
  const styleTag = root.__css ?? ''
  const rules = parseCssRules(styleTag)
  let value
  for (const rule of rules) {
    if (hasPseudo(rule.selector)) continue
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(rule.body)
    if (declaration === null) continue
    const matched = querySelectorAll(root, rule.selector)
    if (matched.includes(node)) value = declaration[1].trim()
  }
  return value
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

const source = readFileSync(process.argv[2] ?? join(here, 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

const M = loaded

/* ── 数据与 props（与 smoke.mjs 保持同构）─────────────────────────────── */

const t = (key, params) => {
  if (params === undefined) return key
  const values = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')
  return values === '' ? key : `${key}(${values})`
}

const makeHook = value => selector => (typeof selector === 'function' ? selector(value) : value)

const baseSessions = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', title: '第一个会话', updatedAt: 1000, retainedBy: { mainView: 1 }, blank: false },
    s2: { id: 's2', title: '第二个会话', updatedAt: 3000, blank: false },
    s3: { id: 's3', title: '第三个会话', updatedAt: 2000, blank: false },
  },
  phase: 'ready',
  projectionsBySession: {},
}

const baseWorkspaces = {
  items: [
    {
      workspaceId: 'w1', path: '/p/alpha', title: 'alpha',
      sessionIds: ['s1', 's2', 's3'], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    },
    {
      workspaceId: 'w2', path: '/p/beta', title: 'beta',
      sessionIds: [], createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z',
    },
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
    openSession: () => {}, startSession: () => {},
    forkSession: () => Promise.resolve(), renameSession: () => Promise.resolve(),
    pinSession: () => Promise.resolve(), unpinSession: () => Promise.resolve(),
    archiveSession: () => Promise.resolve(), unarchiveSession: () => Promise.resolve(),
    renameWorkspace: () => Promise.resolve(), deleteWorkspace: () => Promise.resolve(),
    insertWorkspaceBefore: () => Promise.resolve(), createWorkspace: () => Promise.resolve(),
    searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
    searchResultLimit: 20, pickDirectory: () => Promise.resolve(null),
    hostHome: undefined, notify: () => {},
  }
}

/** 渲染成 DOM 树，并附上插件生成的 CSS。 */
function renderTree(props) {
  elementSeq = 0
  textSeq = 0
  let tree
  if (useReal) {
    // 官方后端：先渲成 HTML，再解析成树（本脚本需要树结构做选择器匹配）。
    const html = RealServer.renderToStaticMarkup(React.createElement(M.__FloatingSidebar, props))
    tree = parseHtmlToTree(html)
  } else {
    tree = renderToTree(React.createElement(M.__FloatingSidebar, props))
  }
  tree.__css = M.__buildCss({ ...M.__DEFAULTS, ...(props.config ?? {}) })
  return tree
}

/* ── 官方后端下的 HTML → 树（极简解析器）──────────────────────────────── */

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

/** 深度优先收集满足谓词的节点。 */
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

console.log('\n=== 解析选择器 / 匹配器自检（防止验证工具本身失效）===')

{
  // 造一棵已知结构的小树，验证匹配器本身是对的。若这组断言不过，
  // 后面关于插件 DOM 的结论一律不可信。
  const makeNode = (tag, attributes = {}) => ({ id: `${tag}-${String(elementSeq++)}`, tag, attributes, children: [], parent: null })
  const rootEl = makeNode('div', { 'data-root': '' })
  const parent = makeNode('div', { 'data-a': '' })
  const rowA = makeNode('div', { 'data-row': '', role: 'treeitem' })
  const rowB = makeNode('div', { 'data-row': '', role: 'treeitem' })
  rootEl.children = [parent]
  parent.parent = rootEl
  parent.children = [rowA, rowB]
  rowA.parent = parent
  rowB.parent = parent
  rootEl.__css = ''

  check('[自检] 子代选择器命中直接子元素',
    querySelectorAll(rootEl, '[data-a] > [data-row]').length === 2,
    String(querySelectorAll(rootEl, '[data-a] > [data-row]').length))
  check('[自检] 相邻兄弟选择器只命中后面的那个',
    querySelectorAll(rootEl, '[data-row] + [data-row]').length === 1,
    String(querySelectorAll(rootEl, '[data-row] + [data-row]').length))
  check('[自检] 相邻兄弟选择器在无兄弟时不命中',
    querySelectorAll(rootEl, '[data-root] > * > * + *').length === 1,
    String(querySelectorAll(rootEl, '[data-root] > * > * + *').length))
  check('[自检] 后代选择器命中',
    querySelectorAll(rootEl, '[data-root] [data-row]').length === 2,
    String(querySelectorAll(rootEl, '[data-root] [data-row]').length))
  check('[自检] 单链上的 * + * 不命中任何元素（正是原 bug 的形态）',
    (() => {
      const chainRoot = makeNode('div', { 'data-list-area': '' })
      const body = makeNode('div', { 'data-tree-body': '' })
      const scroll = makeNode('div', { 'data-list-scroll': '' })
      chainRoot.children = [body]; body.parent = chainRoot
      body.children = [scroll]; scroll.parent = body
      chainRoot.__css = ''
      return querySelectorAll(chainRoot, '[data-list-area] > * > * + *').length === 0
    })())
}

console.log('\n=== 真实渲染的 DOM 上验证间距规则 ===')

const tree = renderTree(makeProps())

/* 行间距规则必须真的命中「相邻的两行」。
 * 这是用户报告的症状：两块相邻背景粘连、中间没有间隔。 */
{
  const sessionRows = find(tree, node => node.attributes['data-dsh-fso-session-row'] !== undefined)
  check('[1] 渲染出了多个会话行', sessionRows.length >= 2, `count=${String(sessionRows.length)}`)

  // 相邻的两个会话行中，后一个应当被间距规则赋予 margin-top。
  const adjacentPairs = sessionRows.filter((row, index) => {
    if (index === 0) return false
    return sessionRows[index - 1].parent === row.parent
  })
  check('[2] 存在同容器内的相邻会话行', adjacentPairs.length >= 1, `count=${String(adjacentPairs.length)}`)

  const withMargin = adjacentPairs.filter(row => {
    const value = resolvedProperty(tree, row, 'margin-top')
    return value !== undefined && parseFloat(value) >= 2
  })
  check('[3] 相邻会话行之间确实有 2px 间距（回归：背景不粘连）',
    withMargin.length === adjacentPairs.length,
    `命中 ${String(withMargin.length)}/${String(adjacentPairs.length)}，` +
    `实际值=${JSON.stringify(adjacentPairs.map(row => resolvedProperty(tree, row, 'margin-top') ?? null))}`)

  // 第一条会话行不该有 margin-top（否则顶部会多出空隙）。
  if (sessionRows.length > 0) {
    const first = sessionRows[0]
    check('[4] 首行不加 margin-top（顶部无多余空隙）',
      (() => {
        const value = resolvedProperty(tree, first, 'margin-top')
        return value === undefined || parseFloat(value) === 0
      })(),
      String(resolvedProperty(tree, first, 'margin-top')))
  }
}

/* 行高与圆角必须仍在（防止修间距时误伤行本身）。 */
{
  const row = find(tree, node => node.attributes['data-dsh-fso-session-row'] !== undefined)[0]
  check('[5] 会话行高度仍为 32px', resolvedProperty(tree, row, 'height') === '32px',
    String(resolvedProperty(tree, row, 'height')))
  check('[6] 会话行仍有圆角', String(resolvedProperty(tree, row, 'border-radius') ?? '').includes('--dsw-radius-md'),
    String(resolvedProperty(tree, row, 'border-radius')))
}

/* group-sessions（分组内的会话容器）内也必须有间距 —— 分组渲染走这条路径。 */
{
  const containers = find(tree, node => node.attributes['data-dsh-fso-group-sessions'] !== undefined)
  check('[7] 渲染出了分组会话容器', containers.length >= 1, `count=${String(containers.length)}`)
  const rowsInGroup = containers.flatMap(container => container.children.filter(child => child.attributes['data-dsh-fso-session-row'] !== undefined))
  const withMargin = rowsInGroup.filter((row, index) => index > 0 && resolvedProperty(tree, row, 'margin-top') !== undefined)
  check('[8] 分组内相邻会话行有间距',
    rowsInGroup.length <= 1 || withMargin.length === rowsInGroup.length - 1,
    `container rows=${String(rowsInGroup.length)} withMargin=${String(withMargin.length)}`)
}

/* 工作区行与它下面的会话容器之间也要有 2px（官方 groupSection > * + *）。 */
{
  const group = find(tree, node => node.attributes['data-dsh-fso-group'] !== undefined)[0]
  check('[9] 分组内工作区行与会话容器之间有间距（官方 groupSection 规则）',
    group !== undefined && group.children.length >= 2 &&
      resolvedProperty(tree, group.children[1], 'margin-top') === '2px',
    group === undefined ? '无分组' : `children=${String(group.children.length)} margin=${
      group.children.length >= 2 ? String(resolvedProperty(tree, group.children[1], 'margin-top')) : 'n/a'}`)
}

/* 相邻分组之间 4px。 */
{
  const groups = find(tree, node => node.attributes['data-dsh-fso-group'] !== undefined)
  const roots = groups.filter(node => node.parent?.attributes['data-dsh-fso-list-scroll'] !== undefined)
  check('[10] 相邻分组之间有 4px 间距',
    roots.length <= 1 || resolvedProperty(tree, roots[1], 'margin-top') === '4px',
    `roots=${String(roots.length)} margin=${roots.length > 1 ? String(resolvedProperty(tree, roots[1], 'margin-top')) : 'n/a'}`)
}

/* 单列表模式同样要有间距（官方 flatList > * + *）。 */
{
  const flatTree = renderTree(makeProps({ config: { groupBy: 'flat' } }))
  const flat = find(flatTree, node => node.attributes['data-dsh-fso-flat-list'] !== undefined)[0]
  check('[11] 渲染出单列表容器', flat !== undefined)
  const rows = flat === undefined ? [] : flat.children.filter(child => child.attributes['data-dsh-fso-session-row'] !== undefined)
  const withMargin = rows.filter((row, index) => index > 0 && resolvedProperty(flatTree, row, 'margin-top') === '2px')
  check('[12] 单列表内相邻会话行有间距（官方 flatList 规则）',
    rows.length <= 1 || withMargin.length === rows.length - 1,
    `rows=${String(rows.length)} withMargin=${String(withMargin.length)}`)
}

/* 滚动容器带 role=tree（官方 .list 也带 role="tree"）。
 * 注：搜索结果的相邻行间距规则（官方 searchTree > treeitem + treeitem）走
 * `searchActive` 分支，而它依赖 `useEffect` 里的防抖远程搜索；本脚本的
 * React 桩不执行 effect，所以搜索态在 layout-check 里无法渲染 —— 那条规则
 * 由 test.mjs 的 CSS 文本断言兜住（见 [24]）。 */
{
  const scroll = find(tree, node => node.attributes['data-dsh-fso-list-scroll'] !== undefined)[0]
  check('[13] 滚动容器带 role=tree', scroll?.attributes.role === 'tree', String(scroll?.attributes.role))
}

/* 滚动必须落在最内层容器上，否则底部渐隐会跟着内容滚走。 */
{
  const listArea = find(tree, node => node.attributes['data-dsh-fso-list-area'] !== undefined)[0]
  const scroll = find(tree, node => node.attributes['data-dsh-fso-list-scroll'] !== undefined)[0]
  check('[14] list-area 自身不滚动（承载 fade 的外层）',
    resolvedProperty(tree, listArea, 'overflow-y') === undefined,
    String(resolvedProperty(tree, listArea, 'overflow-y')))
  check('[15] 最内层 list-scroll 才滚动',
    resolvedProperty(tree, scroll, 'overflow-y') === 'auto',
    String(resolvedProperty(tree, scroll, 'overflow-y')))
}

/* fade 必须有样式（此前它渲染了 DOM 却完全没有 CSS）。 */
{
  const fade = find(tree, node => node.attributes['data-dsh-fso-fade'] !== undefined)[0]
  check('[16] 渲染出底部渐隐节点', fade !== undefined)
  check('[17] 渐隐节点有样式（回归：此前完全没有 CSS）',
    fade !== undefined && resolvedProperty(tree, fade, 'background') !== undefined,
    String(resolvedProperty(tree, fade, 'background')))
  check('[18] 渐隐挂在绝对定位上（不随内容滚动）',
    fade !== undefined && resolvedProperty(tree, fade, 'position') === 'absolute',
    String(resolvedProperty(tree, fade, 'position')))
}

/* 旧的那条失效规则必须已经不存在，避免有人「修回去」。
 * 注意先剥掉注释：CSS 注释里为了说明历史而提到了旧选择器与 `!important`，
 * 那些文字不是生效的样式（test.mjs 同样先剥注释再断言）。 */
{
  const css = tree.__css.replace(/\/\*[\s\S]*?\*\//g, '')
  check('[19] 不再使用对不上层级的 list-area > * > * + * 规则',
    !/[^,{]*\[data-dsh-fso-list-area\]\s*>\s*\*\s*>\s*\*\s*\+/.test(css),
    '旧选择器仍在生效样式中')
  check('[20] 仍不含 !important（生效样式中）', !css.includes('!important'))
  check('[21] 仍不引用官方哈希类名', !/_[A-Za-z0-9]{6}_/.test(css))
  check('[22] 仍不写 grid 覆盖', !css.includes('grid-template-columns'))
  check('[23] hook 顺序无违规', hookViolations.length === 0,
    JSON.stringify(hookViolations.slice(0, 3)))
}

/* ══════════════════════════════════════════════════════════════════════════
 * 结果
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n渲染后端：${useReal ? `官方 react ${RealReact.version ?? '?'} + react-dom/server` : '内置 React 桩'}`)
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
