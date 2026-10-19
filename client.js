/**
 * dsh-sidebar-overlay — 浏览器半：**独立渲染**的浮动侧边栏。
 *
 * ── 与旧 CSS 方案的根本区别 ─────────────────────────────────────────────────
 * 旧的 `dsh-floating-sidebar` 复用官方侧边栏 DOM + CSS 浮层化，代价是结构性的：
 *   1. 必须用 `!important` 覆盖官方 grid（`grid-template-columns: 0px ...`），
 *      侧边栏列宽从 280px 变 0 → **中栏（含全部对话内容）每次开合都重排**；
 *   2. 卡片内有官方 `position: fixed` 的收起按钮，给祖先加 `transform` 会让它
 *      跳位，所以动画只能动 `left` —— 而 `left` **每帧触发 layout**。
 *
 * 本插件完全独立：注册进官方 `shell.overlay` 浮层座位，自建 DOM。
 *   · **不碰官方 grid** → 中栏零重排；
 *   · **不碰官方侧边栏** → 折叠/展开态完全不受影响；
 *   · 动画用 `transform: translateX()`（纯合成），不触发 layout。
 *
 * ── 为什么必须自建 UI（已实测确认的硬约束）──────────────────────────────────
 * 官方 `ui-sidebar` 声明 `sidebar` 为 `single`，`ui-workspace` 声明
 * `sidebar.workspaces` 也为 `single`，二者都已被官方占用。slot 系统的规则是
 * 「声明即认领」（`SlotCore.register`：重复声明同 key 直接抛错），而
 * `renderSlot` 的授权绑定在**注册者自己的 entry** 上：
 *
 *   ui-renderer `boundRenderSlot`：
 *     const declared = entry.children?.[key]
 *     if (declared === undefined) throw new SlotOwnershipError(...)
 *
 * 所以第三方既无法占用官方侧边栏，也无法渲染官方声明的子座位。唯一可行的
 * 独立实现是：注册进 `shell.overlay`（`list`，可自由新增 id），用官方公开的
 * root hooks 取数据，自建一套 UI。
 *
 * ── 数据来源（官方公开契约，不读源码内部）──────────────────────────────────
 *   ui-session  provideRoot → useSessions / useSessionStatus
 *   ui-workspace provideRoot → useWorkspaces
 *   ui-layout   provideRoot → usePanelInfo
 * 这些都是 root scope 座位（`shell.overlay` 正是 `scope: "root"`）自动获得的
 * props，无需自己接线订阅。
 *
 * ── 视觉一致性 ─────────────────────────────────────────────────────────────
 * 官方 `@deepseek-ai/dsh-client-ui-primitives` 是 Web 外壳模块表里的 baseline
 * external（`staticModules` 明确包含它），所以本插件直接 `require` 官方组件
 * （Menu / MenuItemButton / Modal / Tooltip / HoverCard / StateDot / Button /
 * relativeTime）与全套图标，而不是自己画一套。缺失时降级为内置最简实现。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-overlay',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const react = require('react')
    const h = react.createElement

    /**
     * 官方 primitives（软依赖）。
     *
     * 模块表里它是 baseline external，正常都能拿到。用 try/catch + 存在性检查
     * 双保险：万一官方将来挪走它，插件降级为「内置最简组件」而不是整块崩掉。
     */
    let P = {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch (error) {
      console.warn('[sidebar-overlay] ui-primitives 不可用，降级为内置实现:', error?.message ?? error)
      P = {}
    }

    /** 取官方图标组件；缺失时退化为不渲染。 */
    const iconOf = name => P[name] ?? (() => null)

    /**
     * 内置的「人形」图标（官方 `IconUserOutlineMedium` 的等价路径）。
     *
     * 个人信息按钮在**未登录 / 头像未就绪**时靠它兜底。不能只依赖官方图标：
     * primitives 缺失时 `iconOf` 返回空组件，按钮就会变成一个没有任何内容的
     * 圆形空壳 —— 用户看不出那是什么。所以这里内置一份最简 SVG，保证
     * 「看着是个头像入口」这件事永远成立。
     */
    function UserGlyph({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', { cx: 8, cy: 5.4, r: 2.9, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M2.6 13.6c0-2.6 2.4-4.3 5.4-4.3s5.4 1.7 5.4 4.3',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 官方图标（缺失时为空组件）。 */
    const Icons = {
      search: iconOf('IconSearchOutlineRegular'),
      close: iconOf('IconCloseFillRegular'),
      projectAdd: iconOf('IconProjectAddOutlineRegular'),
      sliders: iconOf('IconSlidersTwoOutlineRegular'),
      folderOpen: iconOf('IconFolderOpenRegular'),
      folderClose: iconOf('IconFolderCloseRegular'),
      chevron: iconOf('IconTriangleRightFillRegular'),
      ellipsis: iconOf('IconEllipsisOutlineRegular'),
      pin: iconOf('IconPinFillRegular'),
      /** 未置顶时的空心图钉（官方 `IconPinOutlineRegular`，hover 行内按钮用）。 */
      pinOutline: iconOf('IconPinOutlineRegular'),
      newChat: iconOf('IconNewChatOutlineRegular'),
      /** 个人信息按钮：未登录 / 无头像时的兜底图标。
       *  优先官方 `IconUserOutlineMedium`，缺失时用内置同名规格的 SVG。 */
      user: P.IconUserOutlineMedium ?? UserGlyph,
      edit: iconOf('IconEditOutlineRegular'),
      trash: iconOf('IconTrashOutlineRegular'),
      archive: iconOf('IconArchiveOutlineRegular'),
      unarchive: iconOf('IconUnarchiveOutlineRegular'),
      branch: iconOf('IconBranchOutlineRegular'),
      flatList: iconOf('IconFlatListOutlineRegular'),
      tree: iconOf('IconWorkspaceTreeOutlineRegular'),
      updown: iconOf('IconChevronsUpDownOutlineRegular'),
      clock: iconOf('IconClockOutlineRegular'),
      archiveOff: iconOf('IconArchiveOffOutlineRegular'),
      queue: iconOf('IconQueueOutlineRegular'),
      archiveCheck: iconOf('IconArchiveCheckOutlineRegular'),
    }

    /**
     * 硬依赖：`slots` 是注册浮层的唯一必需服务（没有它插件无意义）。
     *
     * `locale` / `shortcuts` / `uiWorkspace` / `workspaces` / `sessions` 都**不**
     * 声明为硬依赖 —— 声明了会让缺该服务的组合直接加载失败。它们按需软获取：
     * locale / shortcuts 用 `ctx.inject` 等就绪后接线，业务服务在 `inject`
     * 工厂里按调用时读取。
     */
    const inject = ['slots']

    const PANEL_ID = 'sidebar-overlay'
    /** 语言命名空间。 */
    const NS = 'floatingSidebarOverlay'
    /** 官方存储的默认工作区标题；展示时替换为本地化名称。 */
    const DEFAULT_WORKSPACE_TITLE = 'default-workspace'
    /** 折叠态每个分组默认显示的会话条数（官方同值）。 */
    const COLLAPSED_SESSION_LIMIT = 5
    /** 搜索请求防抖（ms）。 */
    const SEARCH_DEBOUNCE_MS = 250

    /** 热区占「窗口左边缘 → 对话内容列左边缘」这段留白的默认比例。
     *  这是**唯一真源**：DEFAULTS 与纯函数的非法值回落都引用它，
     *  避免同一个数字在两处各写一遍后失配。
     *  必须声明在 DEFAULTS **之前**（`const` 有 TDZ，在后面会直接抛错）。 */
    const DEFAULT_TRIGGER_RATIO = 0.4

    /** 默认参数；可被 profile patch 的 config 覆盖。 */
    const DEFAULTS = {
      /** 总开关。 */
      enabled: true,
      /** 卡片宽度（px）。 */
      width: 280,
      /** 卡片四周留白（px）。 */
      gap: 8,
      /** 卡片圆角（px）。 */
      radius: 16,
      /** 左边缘热区：'content' = 对话内容列左边缘 × triggerRatio（默认）；
       *  数值 = 固定像素宽度；'auto' = 官方侧边栏列宽（保底 56）。 */
      trigger: 'content',
      /** `trigger: 'content'` 时，热区右边界占「对话内容列左边缘」的比例。
       *  0.4 表示「窗口左边缘 → 对话区左边缘」这段留白从左往右 40% 都可触发。 */
      triggerRatio: DEFAULT_TRIGGER_RATIO,
      /** 指针离开卡片多远后收回（px）。 */
      closeSlack: 8,
      /** 展开/收回动画时长（ms）；0 = 瞬时。 */
      animationMs: 180,
      /** 卡片底色：'sidebar' 用官方侧边栏填充，'base' 用页面底色。 */
      fill: 'sidebar',
      /** 是否投影（官方 elevation token）。 */
      shadow: true,
      /** 未开投影时是否退化为 0.5px 发丝描边。 */
      border: true,
      /** 是否在折叠态才浮出（展开态不介入）。 */
      onlyWhenCollapsed: true,
      /** 默认分组方式：'workspace' | 'workspace-tree' | 'flat'。 */
      groupBy: 'workspace',
      /** 默认排序方式：'updated' | 'manual'。 */
      orderBy: 'updated',
      /** 默认归档筛选：'default'（隐藏）| 'show'（全部）| 'only'（仅归档）。 */
      archivedFilter: 'default',
      /** 是否显示卡片顶部的「新会话」按钮。 */
      showNewSession: true,
      /** 是否显示卡片左上角的「个人信息」头像按钮（原侧边栏底部的账户入口）。 */
      showProfile: true,
      /** 是否注册总开关快捷键。 */
      hotkey: true,
      /** 总开关快捷键。 */
      hotkeyBinding: { code: 'KeyL', modifiers: ['primary', 'alt'] },
      /** 是否打印诊断信息。 */
      debug: false,
    }

    const ATTR_OFF = 'data-dsh-fso'
    const OFF = 'off'
    /** 卡片自身的打开标记（写在卡片上而不是 <html> 上，避免全局样式重算）。 */
    const ATTR_CARD_OPEN = 'data-open'
    /** 本地视图状态持久化键。 */
    const VIEW_KEY = 'dsh.floatingSidebarOverlay.view.v1'

    /* ══════════════════════════════════════════════════════════════════════
     * 纯函数区（可被测试脚本直接验证，不依赖 DOM / React）
     * ══════════════════════════════════════════════════════════════════════ */

    /**
     * 相对时间分桶。
     *
     * 与官方 `ui-primitives` 的 `relativeTime` 完全同构（同样的阈值），
     * 官方模块可用时优先用官方的，否则用这个。
     *
     * @param {number} at - 事件时刻（epoch ms）。
     * @param {number} now - 当前时刻（epoch ms）。
     */
    function relativeTimeBucket(at, now) {
      const MIN = 6e4
      const HOUR = 36e5
      const DAY = 864e5
      const diff = Math.max(0, now - Number(at || 0))
      if (diff < MIN) return { unit: 'now', n: 0 }
      if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
      if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
      if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
      if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
      return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
    }

    /**
     * 会话行的显示标题（复刻官方 `displayTitle`）。
     *
     * 空白会话显示本地化的「新会话」；有记录但标题为空显示「未命名」；
     * 其余显示标题原文。注意**不使用目录名兜底**——官方明确如此。
     *
     * @param {{blank?: boolean, title?: string, displayTitle?: string}} row
     * @param {(key: string) => string} t
     */
    function rowDisplayTitle(row, t) {
      if (row?.blank === true) return t('session.new')
      const title = typeof row?.title === 'string' ? row.title.trim() : ''
      if (title !== '') return title
      // 快照里的 displayTitle 可能已被官方兜底成目录名/id；只有 title 缺失时才用，
      // 且排除掉「明显是 id」的情况（官方兜底顺序是 title → basename(cwd) → id）。
      const fallback = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
      if (fallback !== '' && fallback !== row?.id && !fallback.startsWith('ses_')) return fallback
      return t('session.untitled')
    }

    /** 官方把 `default-workspace` 显示为本地化默认名。 */
    function workspaceDisplayTitle(title, t) {
      return title === DEFAULT_WORKSPACE_TITLE ? t('workspace.defaultName') : String(title ?? '')
    }

    /**
     * 取路径的最后一段（同时接受 `/` 与 `\`）。
     * @param {string} path
     */
    function workspaceTitleOf(path) {
      const trimmed = String(path ?? '').replace(/[/\\]+$/, '')
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return trimmed.slice(separator + 1)
    }

    /** 路径是否带 Windows 盘符或 UNC 前缀。 */
    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
    }

    /**
     * POSIX 家目录缩写成 `~`（复刻官方 `abbreviateHomePath`）。
     * Windows 路径不缩写（官方行为）。
     */
    function abbreviateHomePath(path, home) {
      if (home === undefined || home === '' || home == null) return path
      if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path
      const root = String(home).replace(/\/+$/, '')
      if (root === '' || root === '/') return path
      if (String(path).replace(/\/+$/, '') === root) return '~'
      if (String(path).startsWith(`${root}/`)) return `~${String(path).slice(root.length)}`
      return path
    }

    /**
     * 会话是否可见（复刻官方 `sessionVisible`）。
     *
     * 规则：子智能体会话始终隐藏；空白会话只有「当前选中的那个」可见；
     * 归档会话按筛选三态决定。
     *
     * @param {object} session - 会话快照行。
     * @param {string|undefined} currentId - 当前主视图会话 id。
     * @param {Set<string>} archived - 归档集合。
     * @param {'default'|'show'|'only'} filter - 归档筛选。
     */
    function sessionVisible(session, currentId, archived, filter) {
      if (session === undefined || session === null) return false
      if (session.origin === 'subagent') return false
      if (session.blank === true && session.id !== currentId) return false
      switch (filter) {
        case 'show': return true
        case 'only': return archived.has(session.id)
        case 'default':
        default: return !archived.has(session.id)
      }
    }

    /**
     * 当前主视图会话 id（官方用 `retainedBy.mainView > 0` 判定）。
     * @param {{byId?: object}} list
     */
    function mainSessionId(list) {
      const byId = list?.byId ?? {}
      for (const session of Object.values(byId)) {
        if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id
      }
      return undefined
    }

    /**
     * 按最近更新降序排列 id（时间相同时按 id 稳定排序）。
     * @param {string[]} ids
     * @param {object} byId
     */
    function orderByRecency(ids, byId) {
      return ids
        .flatMap(id => {
          const summary = byId?.[id]
          if (summary === undefined) return []
          return [{ id, rank: Number(summary.updatedAt) || 0 }]
        })
        .sort((a, b) => {
          if (a.rank !== b.rank) return b.rank - a.rank
          return a.id < b.id ? -1 : 1
        })
        .map(member => member.id)
    }

    /**
     * 把浏览器本地的手动顺序与当前成员集合对齐（复刻官方 `reconcileManualOrder`）。
     *
     * 语义：保存过的相对位置优先；置顶成员补到最前；新分叉插到其来源之前；
     * 其余按最近更新；归档项垫底。补齐只在内存中完成，直到一次显式写入才落盘。
     *
     * @param {string[]} memberIds - 当前分组的成员集合。
     * @param {string[]} savedOrder - 已保存的完整顺序。
     * @param {object} byId - 会话快照。
     * @param {{archivedSessionIds?: string[], pinnedSessionIds?: string[]}} rowState
     */
    function reconcileManualOrder(memberIds, savedOrder, byId, rowState) {
      const members = new Map(memberIds.map(id => [id, id]))
      const included = new Set()
      const ordered = []
      for (const key of savedOrder ?? []) {
        const id = members.get(key)
        if (id === undefined || included.has(key)) continue
        ordered.push(id)
        included.add(key)
      }
      const archived = new Set(rowState?.archivedSessionIds ?? [])
      const pins = []
      for (const sessionId of rowState?.pinnedSessionIds ?? []) {
        const id = members.get(sessionId)
        if (id === undefined || included.has(id) || archived.has(id) || byId?.[id] === undefined) continue
        pins.push(id)
        included.add(id)
      }
      const ordinary = []
      const archives = []
      const rest = orderByRecency([...members.values()].filter(id => !included.has(id)), byId)
      for (const id of rest) {
        if (archived.has(id)) archives.push(id)
        else ordinary.push(id)
      }
      const result = [...pins, ...ordered, ...ordinary, ...archives]
      // 新分叉插到来源之前，且保持来源自身的相对位置。
      const pending = new Set(ordinary)
      const placeFork = id => {
        if (!pending.delete(id)) return
        const parentId = byId?.[id]?.parentId
        if (parentId === undefined || parentId === id || !result.includes(parentId)) return
        placeFork(parentId)
        result.splice(result.indexOf(id), 1)
        result.splice(result.indexOf(parentId), 0, id)
      }
      for (const id of [...ordinary].reverse()) placeFork(id)
      return result
    }

    /**
     * 把选中的空白「新会话」钉到最前（复刻官方 `pinCurrentBlank`）。
     * @param {string[]} order
     * @param {string|undefined} currentBlank
     */
    function pinCurrentBlank(order, currentBlank) {
      if (currentBlank === undefined) return [...order]
      return [currentBlank, ...order.filter(id => id !== currentBlank)]
    }

    /**
     * 置顶分区前置（复刻官方 `sectionMembers`）。
     *
     * 顺序：空白占位 → 置顶（非归档）→ 其余。分区内部保持传入顺序。
     */
    function sectionMembers(members, pinned, archived) {
      const placeholders = []
      const leading = []
      const rest = []
      for (const member of members) {
        if (member.blank === true) placeholders.push(member)
        else if (!archived.has(member.id) && pinned.has(member.id)) leading.push(member)
        else rest.push(member)
      }
      return [...placeholders, ...leading, ...rest]
    }

    /**
     * 会话行的状态（复刻官方 `sessionStatuses`）。
     *
     * 优先级：待处理交互 > 运行中 > 子智能体运行中 > 已完成未查看 > 空闲。
     * 返回数组，首项是主状态。
     *
     * @param {object} node - 派生行节点。
     * @param {(key: string, params?: object) => string} t
     */
    function sessionStatuses(node, t) {
      const subagents = node.runningSubagentCount > 0
        ? {
            state: 'ongoing',
            label: t(node.runningSubagentCount === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: node.runningSubagentCount }),
          }
        : undefined
      let pending
      switch (node.pendingInteraction) {
        case 'approval':
          pending = { state: 'warning', label: t('status.waitingApproval'), trailingLabel: t('status.compact.approval') }
          break
        case 'plan-review':
          pending = { state: 'warning', label: t('status.planReview'), trailingLabel: t('status.compact.planReview') }
          break
        case 'question':
          pending = { state: 'warning', label: t('status.waitingAnswer'), trailingLabel: t('status.compact.answer') }
          break
        default: break
      }
      if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents]
      if (node.running === true) {
        const primary = { state: 'ongoing', label: t('status.running') }
        return subagents === undefined ? [primary] : [primary, subagents]
      }
      if (subagents !== undefined) return [subagents]
      if (node.completed === true) return [{ state: 'done', label: t('status.completed') }]
      return [{ state: 'idle', label: t('status.idle') }]
    }

    /** 只保留行尾可展示的待处理类型（官方 `visiblePendingKind`）。 */
    function visiblePendingKind(kind) {
      return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined
    }

    /**
     * 统计某父会话下正在运行的直接子智能体数量（复刻官方 `runningChildCount`）。
     * @param {object} list - 会话快照。
     * @param {string} parentId
     * @param {Map<string, object>} statuses
     */
    function runningChildCount(list, parentId, statuses) {
      const catalog = list?.projectionsBySession?.[parentId]?.values?.subagentCatalog
      if (!Array.isArray(catalog)) return 0
      let count = 0
      for (const child of catalog) {
        const running = statuses?.get?.(child.id)?.running ?? list?.byId?.[child.id]?.running
        if (running === true) count++
      }
      return count
    }

    /**
     * 把一个会话快照行投影成渲染用的行节点（复刻官方 `sessionNode`）。
     * @param {object} session
     * @param {object} list
     * @param {Map<string, object>} statuses
     * @param {Set<string>} pinned
     * @param {Set<string>} archived
     */
    function sessionNode(session, list, statuses, pinned, archived) {
      const status = statuses?.get?.(session.id)
      const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
      return {
        id: session.id,
        title: session.blank === true ? '' : (typeof session.title === 'string' ? session.title.trim() : ''),
        displayTitle: session.displayTitle,
        blank: session.blank === true,
        running: status?.running ?? session.running,
        runningSubagentCount: runningChildCount(list, session.id, statuses),
        completed: status?.completionUnread === true,
        pinned: !archived.has(session.id) && pinned.has(session.id),
        archived: archived.has(session.id),
        updatedAt: Number(session.updatedAt) || 0,
        parentId: typeof session.parentId === 'string' ? session.parentId : undefined,
        cwd: session.cwd,
        ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
      }
    }

    /**
     * 找出某路径最近的已注册祖先工作区（复刻官方 `owningParentFolder` 语义）。
     *
     * 只用已注册的规范路径做前缀匹配，不扫盘、不解析符号链接。
     * @param {string} path
     * @param {string[]} paths - 全部已注册路径。
     */
    function owningParentFolder(path, paths) {
      const target = String(path ?? '').replace(/[/\\]+$/, '')
      if (target === '') return undefined
      let best
      for (const candidate of paths) {
        const root = String(candidate ?? '').replace(/[/\\]+$/, '')
        if (root === '' || root === target) continue
        // 前缀必须落在路径分隔符上，避免 `/a/bc` 被 `/a/b` 误认。
        if (!target.startsWith(root)) continue
        const next = target.charAt(root.length)
        if (next !== '/' && next !== '\\') continue
        if (best === undefined || root.length > best.length) best = root
      }
      return best
    }

    /**
     * 按配额裁掉空闲会话行（复刻官方 `collapsedSessionRows`）。
     *
     * 关键语义：**空白会话、运行中的会话、有子智能体在跑的父会话不占配额**，
     * 它们始终显示；只有空闲会话才计入 limit。
     *
     * @param {object[]} sessions - 已排序的行节点。
     * @param {number} [limit] - 空闲会话配额，默认 {@link COLLAPSED_SESSION_LIMIT}。
     * @returns {{rows: object[], hiddenCount: number}}
     */
    function collapsedSessionRows(sessions, limit = COLLAPSED_SESSION_LIMIT) {
      let idleCount = 0
      const rows = sessions.filter(session => {
        if (session.blank === true || session.running === true || session.runningSubagentCount > 0) return true
        if (idleCount >= limit) return false
        idleCount += 1
        return true
      })
      return { rows, hiddenCount: sessions.length - rows.length }
    }

    /**
     * 单列表模式的扁平派生（复刻官方 `deriveFlat`）。
     *
     * 与分组模式不同：成员来自**全部**可见会话（按 `list.ids` 顺序，即最近更新
     * 降序），而不是按工作区分组后再拼接。
     *
     * @param {object} list
     * @param {object} options
     */
    function buildFlat(list, options) {
      const { archived, archivedFilter, currentId, ungroupedOrder, pinned, orderBy, statuses, t } = options
      const members = (list.ids ?? []).flatMap(id => {
        const summary = list.byId?.[id]
        if (summary === undefined || !sessionVisible(summary, currentId, archived, archivedFilter)) return []
        return [id]
      })
      const fullOrder = orderBy === 'manual'
        ? reconcileManualOrder(members, ungroupedOrder, list.byId, {
            archivedSessionIds: [...archived],
            pinnedSessionIds: [...pinned],
          })
        : orderByRecency(members, list.byId)
      const sessions = sectionMembers(
        fullOrder.flatMap(id => (list.byId?.[id] === undefined ? [] : [list.byId[id]])),
        pinned,
        archived,
      ).map(session => sessionNode(session, list, statuses, pinned, archived))
      return {
        key: '__flat__',
        workspaceId: undefined,
        cwd: undefined,
        createdAt: undefined,
        label: t('section.sessions'),
        sessions,
        fullOrder,
      }
    }

    /**
     * 按工作区分组（复刻官方 `groupByWorkspace` 的核心）。
     *
     * 每个分组同时给出两份顺序：
     *   · `sessions` —— 渲染用的可见行节点（已按模式排序、分区、投影）；
     *   · `fullOrder` —— **完整**顺序，含被筛选隐藏的归档项。拖拽写入必须基于
     *     它，否则隐藏成员会从手动排序里被抹掉（官方明确要求「完整记账顺序」）。
     *
     * @param {object} list - 会话快照。
     * @param {object[]} workspaces - 工作区视图（Host 顺序）。
     * @param {object} options
     * @returns {{key: string, workspaceId?: string, cwd?: string, createdAt?: number, label: string, sessions: object[], fullOrder: string[]}[]}
     */
    function buildGroups(list, workspaces, options) {
      const { archived, archivedFilter, currentId, ungroupedOrder, manualOrders, pinned, orderBy, statuses, t } = options
      const groups = []
      const accounted = new Set()

      /**
       * 一个分组的完整顺序 → 可见行节点。
       * @param {string[]} ids - 成员 id（可含隐藏项）。
       * @param {string[]|undefined} savedOrder - 该分组保存的手动顺序。
       */
      const project = (ids, savedOrder) => {
        const members = ids.filter(id => list.byId?.[id] !== undefined)
        const fullOrder = orderBy === 'manual'
          ? reconcileManualOrder(members, savedOrder, list.byId, {
              archivedSessionIds: [...archived],
              pinnedSessionIds: [...pinned],
            })
          : orderByRecency(members, list.byId)
        const visible = fullOrder.flatMap(id => {
          const summary = list.byId?.[id]
          if (summary === undefined || !sessionVisible(summary, currentId, archived, archivedFilter)) return []
          return [summary]
        })
        const sessions = sectionMembers(visible, pinned, archived)
          .map(session => sessionNode(session, list, statuses, pinned, archived))
        return { sessions, fullOrder }
      }

      for (const workspace of workspaces) {
        const members = []
        for (const id of workspace.sessionIds ?? []) {
          if (list.byId?.[id] === undefined) continue
          accounted.add(id)
          members.push(id)
        }
        const projected = project(members, manualOrders?.[workspace.workspaceId])
        // 只显示已归档视图时，丢掉没有可见成员的分组（官方行为）。
        if (archivedFilter === 'only' && projected.sessions.length === 0) continue
        groups.push({
          key: workspace.workspaceId,
          workspaceId: workspace.workspaceId,
          cwd: workspace.path,
          createdAt: Date.parse(workspace.createdAt) || 0,
          label: workspaceDisplayTitle(workspace.title, t),
          sessions: projected.sessions,
          fullOrder: projected.fullOrder,
        })
      }

      /* 「未分组」桶只在该有可见成员时才出现。
       *
       * 官方 `groupByWorkspace` 的 stray 是这样算的：
       *   filter(s => s !== undefined && !accounted.has(s.id) && sessionVisible(...))
       * 也就是**先按可见性过滤，再判断 length > 0**。本插件此前先用未过滤的
       * stray 判断非空、到投影阶段才过滤，于是「孤儿会话全是空白会话（blank）
       * 或全被归档」时会造出一个 0 行的空分组——界面上就是一条没有内容的
       * 「未分组」。空白会话在 `sessionVisible` 里默认隐藏（官方行为），所以
       * 用户看到的是一个点开什么都没有的分组。
       *
       * 修法：可见性判断前移。但 fullOrder 仍由**全部** stray 计算——隐藏成员
       * 必须留在手动排序记账里，否则它们重新可见时会从顺序中被抹掉。 */
      const strayAll = (list.ids ?? []).filter(id => list.byId?.[id] !== undefined && !accounted.has(id))
      const strayVisible = strayAll.filter(id => sessionVisible(list.byId[id], currentId, archived, archivedFilter))
      if (strayVisible.length > 0) {
        const projected = project(strayAll, ungroupedOrder)
        groups.push({
          key: '',
          workspaceId: undefined,
          cwd: undefined,
          createdAt: undefined,
          label: t('group.ungrouped'),
          sessions: projected.sessions,
          fullOrder: projected.fullOrder,
        })
      }

      return groups
    }

    /**
     * 按「工作区树」把分组嵌套起来（复刻官方层级语义）。
     *
     * 每个工作区挂到最近的已注册祖先之下；没有祖先的留在根层级。
     * @param {object[]} groups - buildGroups 的结果。
     */
    function nestGroups(groups) {
      const byPath = new Map()
      for (const group of groups) {
        if (group.cwd !== undefined) byPath.set(String(group.cwd).replace(/[/\\]+$/, ''), group)
      }
      const childrenOf = new Map()
      const roots = []
      for (const group of groups) {
        const parentPath = group.cwd === undefined
          ? undefined
          : owningParentFolder(group.cwd, [...byPath.keys()])
        if (parentPath === undefined) {
          roots.push(group)
          continue
        }
        const parent = byPath.get(parentPath)
        if (parent === undefined) {
          roots.push(group)
          continue
        }
        if (!childrenOf.has(parent.key)) childrenOf.set(parent.key, [])
        childrenOf.get(parent.key).push(group)
      }
      return { roots, childrenOf }
    }

    /**
     * 本地搜索：标题与工作区名的即时子串匹配（复刻官方 `deriveSearchResults` 的本地部分）。
     *
     * @param {object} list
     * @param {object[]} workspaces
     * @param {string} query
     * @param {object} options
     */
    function localSearch(list, workspaces, query, options) {
      const { archived, archivedFilter, currentId, statuses, t } = options
      const q = String(query ?? '').trim().toLowerCase()
      if (q === '') return []
      const workspaceBySession = new Map()
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) {
          if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspaceDisplayTitle(workspace.title, t))
        }
      }
      const matched = []
      for (const id of list.ids ?? []) {
        const summary = list.byId?.[id]
        if (summary === undefined || !sessionVisible(summary, currentId, archived, archivedFilter)) continue
        const title = rowDisplayTitle(summary, t).toLowerCase()
        const label = (workspaceBySession.get(id) ?? workspaceTitleOf(summary.cwd) ?? '').toLowerCase()
        if (title.includes(q) || label.includes(q)) matched.push(summary)
      }
      return orderByRecency(matched.map(s => s.id), list.byId)
        .map(id => list.byId[id])
        .map(summary => ({
          ...sessionNode(summary, list, statuses, new Set(), archived),
          workspace: workspaceBySession.get(summary.id) ?? (summary.cwd === undefined ? t('group.ungrouped') : workspaceTitleOf(summary.cwd)),
        }))
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 热区几何（纯函数，可被测试直接验证）
     * ══════════════════════════════════════════════════════════════════════ */

    /** 官方对话内容列宽度的钳制范围（ui-conversation 的定义）。 */
    const CONTENT_WIDTH_MIN = 680
    const CONTENT_WIDTH_MAX = 920
    /** 官方对话内容列宽度相对中栏宽度的比例。 */
    const CONTENT_WIDTH_RATIO = 0.64

    /**
     * 由「中栏宽度」推出官方对话内容列的实际宽度。
     *
     * 官方定义（ConversationRoot 的 body 上）：
     *   --dsh-chat-content-width: var(--dsh-chat-user-width,
     *     clamp(680px, 中栏宽 * .64, 920px))
     * 即：用户拖拽过宽度时用其写入的具体值，否则按中栏宽度取 64%，
     * 并钳制在 680..920 之间。
     *
     * @param {number} columnWidth - 中栏（对话区容器）宽度。
     * @param {number} [userWidth] - 用户自定义宽度；无效时忽略。
     * @returns {number} 内容列宽度（px）。
     */
    function contentColumnWidth(columnWidth, userWidth) {
      if (Number.isFinite(userWidth) && userWidth > 0) return userWidth
      const column = Number.isFinite(columnWidth) && columnWidth > 0 ? columnWidth : 0
      return Math.min(Math.max(CONTENT_WIDTH_MIN, column * CONTENT_WIDTH_RATIO), CONTENT_WIDTH_MAX)
    }

    /**
     * 计算热区右边界。
     *
     * 语义：**「窗口左边缘 → 对话内容列左边缘」这段留白的 `ratio` 比例**。
     * 折叠态下内容列是居中的（`.column{max-width:…;margin:0 auto}`），所以
     * 内容列左边缘 = 容器左边缘 + (容器宽 − 内容列宽) / 2。
     *
     * 结果**向上取整到整数像素**。原因：
     *   1. 浮点误差会让某些比例算出 `x.999999…`（例如 `170 × 0.7` 得到
     *      118.99999999999999），于是整数阈值 `x = 119` 落在热区**外**
     *      （`119 <= 118.9999…` 为 false），与文档写的数字差 1px、边界不可预测。
     *      取整后「文档里写的数字」就是「实际能触发的最后一像素」。
     *   2. 热区是像素级命中区域，「宁多 1px 不少 1px」更符合直觉。
     *
     * @param {object} input
     * @param {number} input.containerLeft - 对话区容器左边缘（视口坐标）。
     * @param {number} input.containerWidth - 对话区容器宽度。
     * @param {number} [input.contentWidth] - 官方给出的内容列宽度（纯数值时优先）。
     * @param {number} [input.userWidth] - 用户自定义内容列宽度（次之）。
     * @param {number} ratio - 占留白的比例（0..1]。
     * @returns {number} 热区右边界（px，视口坐标，整数）。
     */
    function triggerEdge(input, ratio) {
      const left = Number.isFinite(input.containerLeft) ? input.containerLeft : 0
      const width = Number.isFinite(input.containerWidth) && input.containerWidth > 0
        ? input.containerWidth
        : 0
      const content = Number.isFinite(input.contentWidth) && input.contentWidth > 0
        ? input.contentWidth
        : contentColumnWidth(width, input.userWidth)
      // 容器比内容列窄时（窄窗口）内容列退化为整宽。
      const actual = Math.min(width, content)
      const contentLeft = left + (width - actual) / 2
      /* 非法 ratio 回落到默认值；`DEFAULT_TRIGGER_RATIO` 是唯一真源，
       * 避免这里与 DEFAULTS 各写一个数字后失配。 */
      const safeRatio = Number.isFinite(ratio) && ratio > 0
        ? Math.min(ratio, 1)
        : DEFAULT_TRIGGER_RATIO
      return Math.max(24, Math.ceil(contentLeft * safeRatio))
    }

    /**
     * 对话区尚未挂载时的兜底热区：折叠态中栏≈视口宽，按官方公式近似。
     *
     * @param {number} viewportWidth - 视口宽度。
     * @param {number} ratio - 占留白的比例。
     * @returns {number} 热区右边界（px）。
     */
    function fallbackTriggerEdge(viewportWidth, ratio) {
      const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0
      if (viewport === 0) return 24
      return triggerEdge({ containerLeft: 0, containerWidth: viewport }, ratio)
    }

    /**
     * 计算热区**上边界**：热区只在这个 y 之下生效。
     *
     * 需要排除两层上方区域：
     *   1. **窗口标题栏**（Windows 上是 40px，含窗口按钮与「+」新建等）——
     *      传进来的 `titlebarBottom` 就是它；
     *   2. **对话区自己的 header** —— 官方 `ConversationRoot` 的结构是
     *        root (flex column)
     *          ├── header   对话/轨迹 tab、会话标题、面包屑（min-height 76px）
     *          └── body     = `[data-conversation-content]`（flex:1，正好在 header 下方）
     *      所以 body 的**顶边**就是 header 的底边。
     *
     * 取两者较大值：即使 body 顶边因为某种原因偏上（例如 header 被折叠、
     * `min-height:0` 的无 tab 变体），窗口标题栏那一段也仍然被排除。
     *
     * @param {number} bodyTop - 对话内容容器顶边（视口坐标）。
     * @param {number} titlebarBottom - 窗口标题栏底边（视口坐标）。
     * @returns {number} 热区上边界（px，视口坐标）。
     */
    function triggerTopEdge(bodyTop, titlebarBottom) {
      const titlebar = Number.isFinite(titlebarBottom) && titlebarBottom > 0 ? titlebarBottom : 0
      const body = Number.isFinite(bodyTop) && bodyTop > 0 ? bodyTop : 0
      return Math.max(titlebar, body)
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 样式表
     * ══════════════════════════════════════════════════════════════════════ */

    /**
     * 构造样式表。
     *
     * 三条硬约束：
     *   1. **只作用于本插件自己的节点**（`[data-dsh-fso-*]`），不写任何
     *      `!important`，不引用官方哈希类名，不碰官方 grid；
     *   2. 动画只动 `transform` / `opacity`（合成层），不动 `left`（layout）；
     *   3. 尺寸与配色尽量与官方侧边栏一致（行高 34/32、字号 14/10、radius-md…）。
     */
    function buildCss(config) {
      const gap = Math.max(0, Number(config.gap) || 0)
      const radius = Math.max(0, Number(config.radius) || 0)
      const width = Math.max(120, Number(config.width) || 280)
      const animMs = Math.max(0, Number(config.animationMs) || 0)

      const fill = config.fill === 'base'
        ? 'var(--dsw-alias-bg-base)'
        : 'var(--dsw-specific-sidebar-fill)'

      const surface = config.shadow === true
        ? 'box-shadow: var(--dsw-elevation-panel);'
        : (config.border === true ? 'border: .5px solid var(--dsw-alias-border-l3);' : '')

      const transition = animMs > 0
        ? `transition: transform ${animMs}ms cubic-bezier(.32,.72,0,1), opacity ${animMs}ms cubic-bezier(.32,.72,0,1);`
        : ''

      return `
/* ══════════════════════════════════════════════════════════════════════════
 * 样式：逐条对齐官方 ui-sidebar / ui-workspace 的视觉规格
 *
 * 对齐依据是官方 dist 里 SidebarRoot.module.css / Rows.module.css /
 * WorkspaceBrowser.module.css 的实际声明（已从 asar 提取比对）。关键数值：
 *
 *   根容器      padding 6px 12px；font-size 14px；background sidebar-fill
 *   新会话按钮  height 38px；border .5px border-l3；background button-elevated-fill
 *               radius-md；font-weight 500；margin 0 2px 12px；padding 8px 12px
 *   区头        height 36px；padding-left 4px；margin 2px -4px 4px 0；gap 4px
 *   区头标题    max-width 45%；line-height 20px
 *   搜索槽      max-width 28px（收起）→ 100%（展开）
 *   搜索框      height 28px → 30px；展开时 border .5px border-l4、radius-md、
 *               width calc(100% + 4px)、margin-inline -2px
 *   搜索输入    13px；收起时 opacity 0 / width 0 / pointer-events none
 *   区头图标    28×28；radius-sm；色 label-secondary
 *   行内操作键  16×16；radius-xs；色 label-tertiary，hover 变 label-primary
 *   工作区行    height 34px；radius-md；padding 0 8px；gap 6px
 *   会话行      height 32px；gap 0；标题 margin 0 6px 0 4px
 *   行内间距    相邻行 margin-top 2px；相邻分组 margin-top 4px
 *   行首槽      16×20；色 label-tertiary
 *   时间        10px/16px；色 label-tertiary
 *   置顶标记    16×20；margin-left 6px；色 label-caption
 *   列表区      padding-bottom 16px；margin-left -4px；padding-left 4px
 *   展开其余    28px 高；padding-left calc(28px + indent)；12px；hover 无背景、
 *               文字转 label-secondary
 *   空状态      margin-top 80px；13px/20px；图标 label-caption + margin-bottom 4px
 *   拖拽指示    12px 高，渐变三角 + 2px 横线（官方同款）
 *   悬停卡      gap 8px；标题 14px/20px #fff；路径与时间 12px/16px #cfd3d6；
 *               状态 12px/20px #adb2b8、gap 8px
 *   重命名输入   height 44px；radius-lg；padding 7px 14px；14px/22px
 *
 * 三条硬约束（与旧 CSS 方案的差别所在）：
 *   1. 只作用于本插件自己的节点（[data-dsh-fso-*]），不写 !important、
 *      不引用官方哈希类名、不碰官方 grid；
 *   2. 动画只动 transform / opacity（合成层），不动 left（layout）；
 *   3. 悬停卡的配色官方用的是固定浅色（#fff/#cfd3d6/#adb2b8），因为它的底色
 *      始终是深色浮层；这里沿用同值以保证与官方一致。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── 容器：官方 overlayLayer 的子元素 ───────────────────────────────────────
 * overlayLayer 已是 position:absolute; inset:0; pointer-events:none，子元素
 * 自动 pointer-events:auto。这里只负责把卡片摆到左侧。 */
[data-dsh-fso-panel] {
  position: absolute;
  top: var(--dsh-fso-top, 0px);
  bottom: 0;
  left: 0;
  width: ${width + gap * 2}px;
  padding: ${gap}px;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 1;
}

/* ── 卡片本体：对齐官方 SidebarRoot 根容器 ────────────────────────────────
 * 官方根容器结构（_2H3hWW_root）：
 *   padding: 6px 12px; background: sidebar-fill; font-size:14px;
 *   且定义 --dsh-sidebar-inline-padding:12px 供内部各区域引用。
 * 那 12px 的左右内边距是**必要的**：官方列表区用了 margin-right:-12px 之类的
 * 负 margin 把滚动条推到边缘，没有父级内边距吸收就会溢出卡片。 */
[data-dsh-fso-card] {
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /* 官方根容器：上下 6px、左右 12px。 */
  padding: 6px var(--dsh-sidebar-inline-padding);
  border-radius: ${radius}px;
  background: ${fill};
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  /* 官方根容器是 14px。 */
  font-size: 14px;
  /* 官方在根容器上定义 --dsh-sidebar-inline-padding:12px，行与列表都引用它。 */
  --dsh-sidebar-inline-padding: 12px;
  ${surface}
}

/* ── 展开/收回：transform 合成动画 ─────────────────────────────────────────
 * 独立浮层里没有官方的 position:fixed 收起按钮，所以可以安全地用 transform。
 *
 * 关键：开关状态写在**卡片自己的属性**上，而不是 <html> 上。
 * 写在 <html> 上会让浏览器在每次开合时重新匹配整个文档的选择器
 * （旧方案实测这正是「打开时闪一下」的成因之一）。 */
[data-dsh-fso-card] {
  transform: translateX(-110%);
  opacity: 0;
  ${transition}
  will-change: transform, opacity;
  pointer-events: none;
}
[data-dsh-fso-card][data-open] {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-fso-card] { transition: none; }
}

/* ── 顶部一行：个人信息按钮 + 「新会话」─────────────────────────────────
 * 官方侧边栏把账户入口放在**底部**（sidebar.settings → AccountMenu），
 * 折叠成浮层后底部那条不再可见，所以把它挪到卡片顶部、紧挨「新会话」
 * 左边。两者同高（38px）并排：左侧固定宽度的头像圆钮，右侧「新会话」
 * 吃掉剩余宽度。
 *
 * 外边距从按钮本身移到这一行上：否则「关掉新会话按钮」时头像会贴着
 * 卡片上沿，且两者各自的 margin 会叠加出多余的纵向空隙。 */
[data-dsh-fso-topbar] {
  box-sizing: border-box;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 2px 12px;
}

/* ── 顶部「新会话」：对齐官方 newSession ─────────────────────────────────
 * 官方是 38px 高、带 .5px 描边、button-elevated-fill 底、字重 500 的实心按钮，
 * 而不是一个透明的文本行。 */
[data-dsh-fso-new] {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  margin: 0;
  padding: 8px 12px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
}
[data-dsh-fso-new]:hover { background: var(--dsw-alias-button-floating-hover); }
[data-dsh-fso-new]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
[data-dsh-fso-new] > svg { flex: none; }
/* 官方 newSessionShortcut：右侧快捷键提示，宽态才显示。 */
[data-dsh-fso-new-shortcut] { flex: none; margin-left: auto; opacity: .72; }

/* ── 个人信息按钮：侧边栏底部账户入口的「只剩设置」版 ──────────────────
 * 官方宽态是「24px 头像 + 昵称」的 44px 行、点开是账户菜单；这里按需求
 * 压成 38×38 的圆形头像钮，**点一下直接打开设置弹窗**，不再弹菜单，
 * 所以也不再有「联系我们 / 退出登录」两项。
 * 外观规格沿用官方那块头像：24×24 圆形、bg-skeleton 底、label-tertiary 图标。 */
[data-dsh-fso-profile] {
  box-sizing: border-box;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
[data-dsh-fso-profile]:hover { background: var(--dsw-alias-button-floating-hover); }
[data-dsh-fso-profile]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 头像槽：24×24，圆形，底色与官方 AccountMenu.avatar 一致。 */
[data-dsh-fso-profile-avatar] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-skeleton);
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
}
[data-dsh-fso-profile-avatar] > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
/* 头像加载失败/未登录：图标按官方尺寸（16）落在槽内。 */
[data-dsh-fso-profile-avatar] > svg { flex: none; }

/* ── 区头：对齐官方 sectionHeader（36px）─────────────────────────────────
 * 官方在非 rail 态给 sectionHeader 加了 margin-top:2px; margin-right:-4px，
 * 让区头的操作按钮视觉上贴到列表右边线。 */
[data-dsh-fso-header] {
  box-sizing: border-box;
  flex: none;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin: 2px -4px 4px 0;
  padding-left: 4px;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
}
[data-dsh-fso-section-label] {
  flex: none;
  min-width: 0;
  max-width: 45%;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out);
}
[data-dsh-fso-section-label][data-hidden] {
  opacity: 0;
  visibility: hidden;
  max-width: 0;
  margin-right: -4px;
}

/* ── 搜索：对齐官方 searchSlot / search / searchInput ────────────────────
 * 收起态槽位只有 28px（一个图标宽）；展开后占满整行。 */
[data-dsh-fso-search-slot] {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  max-width: 28px;
  margin-left: auto;
  display: flex;
  align-items: center;
  padding-left: 0;
  transition: max-width .18s var(--ds-ease-in-out), padding-left .18s var(--ds-ease-in-out);
}
[data-dsh-fso-search-slot][data-expanded] { max-width: 100%; }

[data-dsh-fso-search] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 0;
  width: 100%;
  height: 28px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: text;
  overflow: hidden;
  transition: width .18s var(--ds-ease-in-out), padding .18s var(--ds-ease-in-out),
              border-color .18s var(--ds-ease-in-out), background-color .18s var(--ds-ease-in-out);
}
/* 展开态：外扩 4px（两侧各 2px），描边 border-l4，色转 label-caption。 */
[data-dsh-fso-search][data-expanded] {
  width: calc(100% + 4px);
  height: 30px;
  margin-inline: -2px;
  padding: 0 4px 0 0;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-caption);
}
[data-dsh-fso-search-button] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[data-dsh-fso-search][data-expanded] [data-dsh-fso-search-button] { height: 30px; }
[data-dsh-fso-search-button]:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* 展开后按钮的 hover 底色要去掉（官方如此，避免和输入区打架）。 */
[data-dsh-fso-search][data-expanded] [data-dsh-fso-search-button]:hover { background: transparent; }

[data-dsh-fso-search-input] {
  flex: 1;
  min-width: 0;
  width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  /* 收起态输入框完全不可见、不可点。 */
  opacity: 0;
  pointer-events: none;
  transition: opacity .12s var(--ds-ease-in-out);
}
[data-dsh-fso-search][data-expanded] [data-dsh-fso-search-input] {
  opacity: 1;
  pointer-events: auto;
  margin-left: -2px;
}
[data-dsh-fso-search-input]::placeholder { color: var(--dsw-alias-label-tertiary); }

[data-dsh-fso-clear-button] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-dsh-fso-clear-button]:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* ── 区头图标按钮：对齐官方 iconButton（28×28 / radius-sm）────────────── */
[data-dsh-fso-icon-button] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-dsh-fso-icon-button]:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-fso-icon-button]:focus-visible,
[data-dsh-fso-search-button]:focus-visible,
[data-dsh-fso-clear-button]:focus-visible,
[data-dsh-fso-project-row]:focus-visible,
[data-dsh-fso-session-row]:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}

/* ── 行内操作按钮：官方 Rows.iconButton 是 16×16、radius-xs、
 *    色 label-tertiary，hover 才转 label-primary（不是 28×28 的区头按钮）。 */
[data-dsh-fso-row-actions] [data-dsh-fso-icon-button] {
  width: 16px;
  height: 16px;
  border-radius: var(--dsw-radius-xs);
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-fso-row-actions] [data-dsh-fso-icon-button]:hover {
  color: var(--dsw-alias-label-primary);
  background: transparent;
}
/* 工作区行的操作区高度略高（官方 .projectRow .rowActions{height:20px}）。 */
[data-dsh-fso-project-row] [data-dsh-fso-row-actions] { height: 20px; }

[data-dsh-fso-header-actions] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out);
}
[data-dsh-fso-header-actions][data-hidden] {
  visibility: hidden;
  pointer-events: none;
  opacity: 0;
  max-width: 0;
}

/* ── 列表区：对齐官方 listArea → treeBody → list 三层 ────────────────────
 * 官方给列表做了负 margin 外扩 + 内补，让滚动条贴在卡片边缘外侧。
 *
 * 滚动放在**最内层的 list-scroll**，不是 list-area —— 官方的 fade 渐隐
 * 挂在**不滚动**的 treeBody 上；若把滚动留在 list-area，渐隐会跟着内容一起
 * 滚走，等于没有。 */
[data-dsh-fso-list-area] {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 官方 .listArea：负 margin 外扩（让内层滚动条能贴到卡片边缘外侧），
   * 只留 padding-left；overflow 保持 visible，滚动交给内层。 */
  margin-left: -4px;
  margin-right: calc(-1 * var(--dsh-sidebar-inline-padding));
  padding-left: 4px;
}
[data-dsh-fso-tree-body] {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
[data-dsh-fso-list-scroll] {
  flex: 1;
  min-height: 0;
  /* 刻意**不用** display:flex —— 官方 .list 就是块级容器。
   * 若设成 flex 列，行会成为 flex 项（默认 flex-shrink:1），一旦内容超出
   * 高度就会被压扁成不等高，而不是正常滚动。 */
  /* 官方 .list：自己再外扩 4px 以抵消 listArea 的 padding-left，
   * 右内补 = 边距 - 滚动条宽 - 滚动条偏移，让滚动条距卡片边缘正好 2px。
   * 这两层必须分开写 —— 合并到 listArea 上会让滚动条整体左移 3px。 */
  margin-left: -4px;
  margin-right: 2px;
  padding-left: 4px;
  padding-right: calc(var(--dsh-sidebar-inline-padding) - 5px - 2px);
  padding-bottom: 16px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}
/* 底部渐隐：官方 24px 渐变，darwin 下隐藏。 */
[data-dsh-fso-fade] {
  position: absolute;
  left: 0;
  right: var(--dsh-sidebar-inline-padding);
  bottom: 0;
  height: 24px;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill));
}
[data-platform=darwin] [data-dsh-fso-fade] { display: none; }

/* ── 相邻行 2px、相邻分组 4px ─────────────────────────────────────────────
 * 对齐官方的三条规则：
 *   .flatList > * + *            （单列表）
 *   .searchTree > [role=treeitem] + [role=treeitem]   （搜索结果）
 *   .groupSection > * + *        （分组内：工作区行 / 子分组 / 会话行）
 * 但选择器**必须落在真正承载行的容器**上。
 *
 * 这里踩过一个「静默失效」的坑（症状：相邻会话行都显示背景时上下粘连、
 * 中间没有间隔）。早先照抄官方结构时写成了：
 *
 *   [data-dsh-fso-list-area] > * > * + *
 *
 * 而 list-area 之下是 tree-body → list-scroll 的**单链**，相邻兄弟选择器
 * （星号加号星号）要求左侧存在兄弟元素：list-scroll 根本没有兄弟，于是整条
 * 规则一个元素都匹配不到，行间距全程为 0。规则本身没错，是层级对不上，
 * 所以既不会报错也测不出来。
 *
 * 插件比官方在分组内还多一层 group-sessions（官方会话行是 groupSection 的
 * 直接子元素），所以必须显式补上它。 */
[data-dsh-fso-group] > * + *,
[data-dsh-fso-group-sessions] > * + *,
[data-dsh-fso-flat-list] > * + * { margin-top: 2px; }
[data-dsh-fso-list-scroll] > [role="treeitem"] + [role="treeitem"] { margin-top: 2px; }
[data-dsh-fso-group] { position: relative; display: flex; flex-direction: column; }
[data-dsh-fso-group] + [data-dsh-fso-group] { margin-top: 4px; }
[data-dsh-fso-group-sessions] { display: flex; flex-direction: column; }

/* ── 行：工作区 34px / 会话 32px（对齐官方 Rows）───────────────────────── */
[data-dsh-fso-project-row],
[data-dsh-fso-session-row] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
  user-select: none;
  color: var(--dsw-alias-label-primary);
}
[data-dsh-fso-project-row] { height: 34px; }
[data-dsh-fso-session-row] { height: 32px; gap: 0; }
[data-dsh-fso-project-row]:hover,
[data-dsh-fso-session-row]:hover,
[data-dsh-fso-session-row][data-selected] {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-fso-slot] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
/* 工作区文件夹图标：与标题同为正文色。
 *
 * 官方 Rows 让 .slot 用 label-tertiary（灰）来弱化「非激活」的文件夹，
 * 只有含当前会话时才叠 .folderActive 转 business 主色。但这种灰看起来像
 * 「该工作区被禁用 / 不可用」，与它实际可点、可展开的语义冲突，所以这里
 * 把未激活态也提到正文色：图标与标题一致为黑，激活态仍用主色区分。
 *
 * 特异性说明：本规则（100）与 [data-dsh-fso-slot]（100）相同，靠**顺序
 * 在后**覆盖它；[data-dsh-fso-folder][data-active]（200）再覆盖本条。 */
[data-dsh-fso-folder] { color: var(--dsw-alias-label-primary); }
[data-dsh-fso-folder][data-active] { color: var(--dsw-alias-state-business-primary); }
/* 官方 chevron 常驻 DOM，仅 hover 时显示（与 folder 互换位置，二者同为 16px 槽位，
 * 所以切换不会产生布局跳动）。 */
[data-dsh-fso-chevron] { display: none; color: var(--dsw-alias-label-caption); }
[data-dsh-fso-project-row]:hover [data-dsh-fso-chevron] { display: inline-flex; }
[data-dsh-fso-project-row]:hover [data-dsh-fso-folder] { display: none; }
[data-dsh-fso-chevron] > svg { transition: transform .15s var(--ds-ease-in-out); }
[data-dsh-fso-chevron][data-open] > svg { transform: rotate(90deg); }
/* 官方 projectText：flex column 容器，包住标题（工作区树的副标题也放这里）。 */
[data-dsh-fso-project-text] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

[data-dsh-fso-title] {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-fso-session-row] [data-dsh-fso-title] { margin: 0 6px 0 4px; }
[data-dsh-fso-time] {
  flex: none;
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
[data-dsh-fso-pin] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  margin-left: 6px;
  color: var(--dsw-alias-label-caption);
}
/* 归档行标题转 label-caption（官方 archived 规则）。 */
[data-dsh-fso-session-row][data-archived] [data-dsh-fso-title] { color: var(--dsw-alias-label-caption); }

[data-dsh-fso-row-actions] {
  flex: none;
  display: none;
  align-items: center;
  gap: 10px;
}
[data-dsh-fso-project-row]:hover [data-dsh-fso-row-actions],
[data-dsh-fso-session-row]:hover [data-dsh-fso-row-actions],
[data-dsh-fso-project-row][data-menu-open] [data-dsh-fso-row-actions],
[data-dsh-fso-session-row][data-menu-open] [data-dsh-fso-row-actions] {
  display: inline-flex;
}
/* 时间与置顶标记：**hover 或菜单打开**时都要隐藏。
 * 官方（Rows.module.css）：
 *   .sessionRow:hover .time, .sessionRow.menuOpen .time,
 *   .sessionRow:hover .pinIndicator, .sessionRow.menuOpen .pinIndicator { display:none }
 * 原因是 hover 会浮出行内按钮（归档 / 置顶 / ...），而置顶按钮正好落在
 * pinIndicator 的位置上、时间也要让位给按钮，否则两者会挤在一起。 */
[data-dsh-fso-session-row]:hover [data-dsh-fso-time],
[data-dsh-fso-session-row][data-menu-open] [data-dsh-fso-time],
[data-dsh-fso-session-row]:hover [data-dsh-fso-pin],
[data-dsh-fso-session-row][data-menu-open] [data-dsh-fso-pin] { display: none; }

/* hover / 菜单打开时标题改用 clip：省略号会与跑马灯揭示的文本相遇
 * （官方 @media (hover:hover) 里同款处理）。 */
@media (hover: hover) {
  [data-dsh-fso-session-row]:hover [data-dsh-fso-title],
  [data-dsh-fso-session-row][data-menu-open] [data-dsh-fso-title] { text-overflow: clip; }
}

/* ── 拖拽插入指示器：官方是 12px 高的渐变三角 + 2px 横线 ──────────────────
 * 用 background 的多个 linear-gradient 拼出「左端小三角 + 横线」，与官方同款。 */
[data-dsh-fso-session-row][data-drop],
[data-dsh-fso-project-row][data-drop] { position: relative; }
[data-dsh-fso-session-row][data-drop]::after,
[data-dsh-fso-project-row][data-drop]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 4px;
  height: 12px;
  z-index: 1;
  pointer-events: none;
  background:
    linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,
    linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,
    linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;
}
[data-dsh-fso-session-row][data-drop="before"]::after,
[data-dsh-fso-project-row][data-drop="before"]::after { top: -7px; }
[data-dsh-fso-session-row][data-drop="after"]::after,
[data-dsh-fso-project-row][data-drop="after"]::after { bottom: -7px; }
[data-dsh-fso-session-row][data-dragging],
[data-dsh-fso-project-row][data-dragging] { opacity: .4; }

/* ── 「展开其余」/「收起」：对齐官方 sessionOverflowButton ───────────────
 * 官方 hover 不加背景，只把文字从 tertiary 提到 secondary。 */
[data-dsh-fso-overflow] {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  display: flex;
  align-items: center;
  /* 官方：padding 0 12px 0 calc(28px + indent)，让文字与上方的会话行对齐。 */
  padding: 0 12px 0 calc(28px + var(--dsh-workspace-indent, 0px));
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
[data-dsh-fso-overflow]:hover {
  color: var(--dsw-alias-label-secondary);
  background: transparent;
}

/* ── 空状态：对齐官方 emptyState ───────────────────────────────────────── */
[data-dsh-fso-empty] {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 80px;
  padding: 0 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
[data-dsh-fso-empty] > svg {
  color: var(--dsw-alias-label-caption);
  margin-bottom: 4px;
}
[data-dsh-fso-empty-action] {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--dsw-alias-link);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

/* ── 搜索结果：对齐官方 searchResultRow ───────────────────────────────── */
[data-dsh-fso-result] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  min-height: 48px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
}
[data-dsh-fso-result]:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-fso-result-heading] { display: flex; align-items: center; min-width: 0; }
/* 搜索结果行的操作区靠右（官方 .searchResultHeading .rowActions 上写了
 * margin-left:auto）。 */
[data-dsh-fso-result-heading] [data-dsh-fso-row-actions] { margin-left: auto; }
[data-dsh-fso-result-title] {
  flex: 0 auto;
  min-width: 0;
  margin-left: 4px;
  font-size: 14px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-fso-result-meta] { display: flex; align-items: center; gap: 6px; min-width: 0; margin-left: 20px; }
[data-dsh-fso-result-workspace],
[data-dsh-fso-result-snippet] {
  font-size: 12px;
  line-height: 17px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-fso-result-workspace] { flex: none; max-width: 40%; color: var(--dsw-alias-label-tertiary); }
[data-dsh-fso-result-snippet] { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); }
[data-dsh-fso-result-status] {
  padding: 10px 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-fso-result][data-archived] [data-dsh-fso-result-title],
[data-dsh-fso-result][data-archived] [data-dsh-fso-result-workspace],
[data-dsh-fso-result][data-archived] [data-dsh-fso-result-snippet] {
  color: var(--dsw-alias-label-caption);
}

/* ── 悬停卡内容：官方用的是固定浅色（卡底始终是深色浮层）───────────────── */
[data-dsh-fso-hover-content] { display: flex; flex-direction: column; gap: 8px; }
[data-dsh-fso-hover-title] {
  color: #fff;
  overflow-wrap: break-word;
  font-size: 14px;
  line-height: 20px;
}
[data-dsh-fso-hover-path] {
  color: #cfd3d6;
  word-break: break-all;
  font-size: 12px;
  line-height: 16px;
}
[data-dsh-fso-hover-time] { color: #cfd3d6; font-size: 12px; line-height: 16px; }
[data-dsh-fso-hover-status] {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #adb2b8;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-fso-hover-archived] > svg { flex-shrink: 0; margin: 0 -4px; }

/* ── 模态框内的辅助样式：对齐官方 modalError / modalStatus / renameInput ── */
[data-dsh-fso-rename-input] {
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  padding: 7px 14px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  outline: none;
}
[data-dsh-fso-modal-error] {
  margin-top: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-fso-modal-status] {
  margin-top: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-fso-modal-action] { min-width: 72px; }
[data-dsh-fso-modal-action][data-danger]:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
[data-dsh-fso-activity] {
  margin: 0 0 8px;
  padding-left: 18px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
[data-dsh-fso-activity] li { overflow-wrap: anywhere; }
/* 模态框底部按钮最小宽度（官方 modalAction）与危险色（官方 deleteAction）。 */
[data-dsh-fso-modal-action] { min-width: 72px; }
[data-dsh-fso-delete-action]:not(:disabled) { color: var(--dsw-alias-state-error-primary); }

@media (prefers-reduced-motion: reduce) {
  [data-dsh-fso-search],
  [data-dsh-fso-section-label],
  [data-dsh-fso-search-slot],
  [data-dsh-fso-search-input],
  [data-dsh-fso-header-actions],
  [data-dsh-fso-chevron] > svg { transition: none; }
}
`
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 语言字典
     * ══════════════════════════════════════════════════════════════════════ */

    const ZH = {
      'section.workspaces': '工作区',
      'section.sessions': '会话',
      'group.ungrouped': '未分组',
      'workspace.defaultName': '默认工作区',
      'workspace.add': '添加工作区',
      'menu.addWorkspace': '添加工作区…',
      'picker.loading': '正在加载工作区…',
      'folderError.title': '无法打开文件夹',
      'folderError.retry': '重新选择',
      'session.new': '新会话',
      'session.new.label': '新建会话',
      /* 个人信息按钮：只打开设置，所以文案就是「设置」。
       * 已登录/未登录用于 tooltip 与 aria-label（头像本身不显示昵称）。 */
      'profile.openSettings': '打开设置',
      'profile.signedIn': '已登录 DeepSeek',
      'profile.signedOut': '未登录',
      'session.untitled': '未命名',
      'search': '搜索会话',
      'search.sessions.aria': '搜索会话',
      'search.results.aria': '搜索结果',
      'search.placeholder': '搜索会话名称',
      'search.clear': '清除搜索',
      'search.noMatches': '无匹配会话',
      'search.pending': '正在搜索会话历史…',
      'search.hasMore': '仅显示前 {n} 条结果，请缩小搜索范围。',
      'viewOptions.label': '视图选项',
      'groupBy.label': '分组方式',
      'groupBy.workspace': '按工作区',
      'groupBy.workspaceTree': '按工作区树',
      'groupBy.flat': '单列表',
      'orderBy.label': '排序方式',
      'orderBy.manual': '手动排序',
      'orderBy.updated': '最近更新',
      'filterBy.label': '筛选会话',
      'viewOptions.hideArchived': '隐藏已归档',
      'viewOptions.showArchived': '全部对话（显示已归档）',
      'viewOptions.onlyArchived': '仅显示已归档',
      'sessions.expand': '展开其余 {n} 个会话',
      'sessions.collapse': '收起',
      'empty.none': '暂无会话',
      'empty.noneArchived': '暂无已归档会话',
      'empty.viewOthers': '查看其他会话',
      'actions.session.aria': '会话“{name}”的操作',
      'actions.workspace.aria': '工作区“{name}”的操作',
      'actions.unarchive': '取消归档',
      /* 行内 hover 按钮的 Tooltip 文案（官方 `actions.*`，与菜单项 `menu.*` 分开：
       * Tooltip 说「动作」，aria-label 说「对哪个对象做什么」）。 */
      'actions.archive': '归档会话',
      'actions.pin': '置顶会话',
      'actions.unpin': '取消置顶',
      'actions.newSession': '新会话',
      'actions.newSession.aria': '在“{name}”中新建会话',
      'menu.pinSession': '置顶会话',
      'menu.unpinSession': '取消置顶',
      'menu.renameSession': '重命名会话',
      'menu.fork': '分叉会话',
      'menu.archiveSession': '归档会话',
      'menu.unarchiveSession': '取消归档',
      'menu.renameWorkspace': '重命名',
      'menu.deleteWorkspace': '删除工作区',
      'row.pinned': '已置顶',
      'row.archived': '已归档',
      'hover.created': '创建于 {time}',
      'hover.copied': '已复制',
      'date.ymd': '{y}年{m}月{d}日',
      'copy': '复制',
      'cancel': '取消',
      'close': '关闭',
      'confirm': '确定',
      'time.now': '刚刚',
      'time.minutes': '{n}分钟',
      'time.hours': '{n}小时',
      'time.days': '{n}天',
      'time.months': '{n}个月',
      'time.years': '{n}年',
      'time.ago': '{t}前',
      'status.waitingApproval': '等待审批',
      'status.planReview': '计划待审',
      'status.waitingAnswer': '等待回答',
      'status.running': '进行中',
      'status.completed': '已完成',
      'status.idle': '空闲',
      'status.compact.approval': '待审批',
      'status.compact.planReview': '计划待审',
      'status.compact.answer': '待回答',
      'status.subagentsRunning.one': '{n} 个子智能体运行中',
      'status.subagentsRunning.other': '{n} 个子智能体运行中',
      'archive.confirm.title': '停止并归档此会话？',
      'archive.confirm.desc': '“{title}”仍有正在进行的工作。归档会先停止这些工作；之后可在侧栏筛选“全部对话（显示已归档）”中恢复会话，被停止的工作不会自动继续。',
      'archive.confirm.activity': '将被停止的工作',
      'archive.confirm.action': '停止并归档',
      'archive.confirm.pending': '正在停止并归档…',
      'archive.confirm.turn': '进行中的回合',
      'archive.confirm.subagents.one': '{n} 个运行中的子智能体：{names}',
      'archive.confirm.subagents.other': '{n} 个运行中的子智能体：{names}',
      'archive.confirm.jobs.one': '{n} 个后台任务：{names}',
      'archive.confirm.jobs.other': '{n} 个后台任务：{names}',
      'archive.confirm.schedules.one': '{n} 条定时提醒：{names}',
      'archive.confirm.schedules.other': '{n} 条定时提醒：{names}',
      'archive.confirm.other.one': '{n} 项其他工作（{kind}）',
      'archive.confirm.other.other': '{n} 项其他工作（{kind}）',
      'archive.confirm.listSeparator': '、',
      'rename.workspace.title': '重命名工作区',
      'rename.session.title': '重命名会话',
      'field.workspaceName': '工作区名称',
      'field.sessionName': '会话名称',
      'conflict.named': '已存在名为“{name}”的工作区。',
      'delete.workspace': '删除工作区',
      'delete.desc': '将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。',
      'delete.pending': '正在删除工作区…',
      'delete.action': '删除',
      'toast.archived': '会话已归档，可',
      'toast.stoppedAndArchived': '已停止并归档，可',
      'toast.archivedUndo': '撤销',
      'toast.archivedOr': '或',
      'toast.archivedFilter': '筛选已归档会话',
      'toast.archivedNotOpenable': '已归档对话暂时无法查看，请取消归档后查看',
      'toast.pinFailed': '置顶失败，请稍后重试',
      'toast.unpinFailed': '取消置顶失败，请稍后重试',
      'toast.createFailed': '新建会话失败：{message}',
      'shortcut.noSession': '请先选择一个会话',
      'shortcut.noPicker': '目录选择器不可用',
      'shortcut.directoryBusy': '正在选择或添加工作区',
      'shortcut.noCompletedTurn': '当前会话没有已结束的轮次',
      'shortcut.forkFailed': '无法分叉会话，请重试',
      'toggle.label': '切换独立浮动侧边栏',
    }

    const EN = {
      'section.workspaces': 'Workspaces',
      'section.sessions': 'Sessions',
      'group.ungrouped': 'Ungrouped',
      'workspace.defaultName': 'Default workspace',
      'workspace.add': 'Add workspace',
      'menu.addWorkspace': 'Add workspace…',
      'picker.loading': 'Loading workspaces…',
      'folderError.title': 'Cannot open the folder',
      'folderError.retry': 'Choose again',
      'session.new': 'New Session',
      'session.new.label': 'New session',
      'profile.openSettings': 'Open settings',
      'profile.signedIn': 'Signed in to DeepSeek',
      'profile.signedOut': 'Signed out',
      'session.untitled': 'Untitled',
      'search': 'Search sessions',
      'search.sessions.aria': 'Search sessions',
      'search.results.aria': 'Search results',
      'search.placeholder': 'Search session names',
      'search.clear': 'Clear search',
      'search.noMatches': 'No matching sessions',
      'search.pending': 'Searching session history…',
      'search.hasMore': 'Showing the first {n} results. Narrow your search.',
      'viewOptions.label': 'View options',
      'groupBy.label': 'Group by',
      'groupBy.workspace': 'Workspace',
      'groupBy.workspaceTree': 'Workspace tree',
      'groupBy.flat': 'Flat list',
      'orderBy.label': 'Sort by',
      'orderBy.manual': 'Manual',
      'orderBy.updated': 'Recent',
      'filterBy.label': 'Filter sessions',
      'viewOptions.hideArchived': 'Hide archived',
      'viewOptions.showArchived': 'All conversations (show archived)',
      'viewOptions.onlyArchived': 'Archived only',
      'sessions.expand': 'Show {n} more sessions',
      'sessions.collapse': 'Show less',
      'empty.none': 'No sessions yet',
      'empty.noneArchived': 'No archived sessions',
      'empty.viewOthers': 'View other sessions',
      'actions.session.aria': 'Actions for session "{name}"',
      'actions.workspace.aria': 'Actions for workspace "{name}"',
      'actions.unarchive': 'Unarchive',
      'actions.archive': 'Archive',
      'actions.pin': 'Pin',
      'actions.unpin': 'Unpin',
      'actions.newSession': 'New Session',
      'actions.newSession.aria': 'New session in "{name}"',
      'menu.pinSession': 'Pin session',
      'menu.unpinSession': 'Unpin session',
      'menu.renameSession': 'Rename',
      'menu.fork': 'Fork session',
      'menu.archiveSession': 'Archive session',
      'menu.unarchiveSession': 'Unarchive',
      'menu.renameWorkspace': 'Rename',
      'menu.deleteWorkspace': 'Delete workspace',
      'row.pinned': 'Pinned',
      'row.archived': 'Archived',
      'hover.created': 'Created {time}',
      'hover.copied': 'Copied',
      'date.ymd': '{m}/{d}/{y}',
      'copy': 'Copy',
      'cancel': 'Cancel',
      'close': 'Close',
      'confirm': 'Confirm',
      'time.now': 'now',
      'time.minutes': '{n}min',
      'time.hours': '{n}h',
      'time.days': '{n}d',
      'time.months': '{n}mo',
      'time.years': '{n}y',
      'time.ago': '{t} ago',
      'status.waitingApproval': 'Waiting for approval',
      'status.planReview': 'Plan awaiting review',
      'status.waitingAnswer': 'Waiting for an answer',
      'status.running': 'Running',
      'status.completed': 'Completed',
      'status.idle': 'Idle',
      'status.compact.approval': 'Approval',
      'status.compact.planReview': 'Plan review',
      'status.compact.answer': 'Answer',
      'status.subagentsRunning.one': '{n} subagent running',
      'status.subagentsRunning.other': '{n} subagents running',
      'archive.confirm.title': 'Stop and archive this session?',
      'archive.confirm.desc': '"{title}" still has work in progress. Archiving stops that work first; the session can be restored later under "All conversations (show archived)". Stopped work does not resume automatically.',
      'archive.confirm.activity': 'Work that will be stopped',
      'archive.confirm.action': 'Stop and archive',
      'archive.confirm.pending': 'Stopping and archiving…',
      'archive.confirm.turn': 'A turn in progress',
      'archive.confirm.subagents.one': '{n} running subagent: {names}',
      'archive.confirm.subagents.other': '{n} running subagents: {names}',
      'archive.confirm.jobs.one': '{n} background job: {names}',
      'archive.confirm.jobs.other': '{n} background jobs: {names}',
      'archive.confirm.schedules.one': '{n} scheduled reminder: {names}',
      'archive.confirm.schedules.other': '{n} scheduled reminders: {names}',
      'archive.confirm.other.one': '{n} other item ({kind})',
      'archive.confirm.other.other': '{n} other items ({kind})',
      'archive.confirm.listSeparator': ', ',
      'rename.workspace.title': 'Rename workspace',
      'rename.session.title': 'Rename session',
      'field.workspaceName': 'Workspace name',
      'field.sessionName': 'Session name',
      'conflict.named': 'A workspace named "{name}" already exists.',
      'delete.workspace': 'Delete workspace',
      'delete.desc': 'Removes "{name}" from the workspace list. The folder and its session records stay; its sessions appear under "Ungrouped".',
      'delete.pending': 'Deleting workspace…',
      'delete.action': 'Delete',
      'toast.archived': 'Session archived, ',
      'toast.stoppedAndArchived': 'Stopped and archived, ',
      'toast.archivedUndo': 'Undo',
      'toast.archivedOr': 'or',
      'toast.archivedFilter': 'Filter archived sessions',
      'toast.archivedNotOpenable': 'Archived conversations cannot be viewed yet. Unarchive it first.',
      'toast.pinFailed': 'Failed to pin. Try again later.',
      'toast.unpinFailed': 'Failed to unpin. Try again later.',
      'toast.createFailed': 'Failed to create a session: {message}',
      'shortcut.noSession': 'Select a session first',
      'shortcut.noPicker': 'The directory picker is unavailable',
      'shortcut.directoryBusy': 'A workspace is being chosen or added',
      'shortcut.noCompletedTurn': 'This session has no completed turn',
      'shortcut.forkFailed': 'Could not fork the session. Try again.',
      'toggle.label': 'Toggle the standalone floating sidebar',
    }

    /**
     * 极简插值：把 `{name}` 替换成 params 里的值。
     * 官方 locale 的 `t` 支持同样语法；这里是缺失 locale 服务时的兜底。
     */
    function interpolate(text, params) {
      if (params === undefined) return text
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => {
        const value = params[key]
        return value === undefined ? whole : String(value)
      })
    }

    /** 不依赖 locale 服务的兜底翻译函数。 */
    function makeFallbackT() {
      const dict = { zh: ZH, en: EN }
      let lang = 'zh'
      try {
        const stored = localStorage.getItem('dsh.locale')
        if (typeof stored === 'string' && stored.startsWith('en')) lang = 'en'
      } catch { /* localStorage 不可用时用默认 */ }
      return (key, params) => interpolate(dict[lang]?.[key] ?? ZH[key] ?? key, params)
    }

    /**
     * 兜底翻译函数的**单例**。
     *
     * 必须缓存：组件里 `t` 是多个 `useMemo` / `useCallback` 的依赖项，若每次
     * 渲染都新建一个函数引用，那些记忆化会全部失效，每帧重算分组与搜索。
     */
    let cachedFallbackT
    function fallbackT() {
      if (cachedFallbackT === undefined) cachedFallbackT = makeFallbackT()
      return cachedFallbackT
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 视图状态（本地持久化）
     * ══════════════════════════════════════════════════════════════════════ */

    /** 读取本地视图状态；任何异常都退化为默认值。 */
    function readViewState(config) {
      const fallback = {
        groupBy: config.groupBy,
        orderBy: config.orderBy,
        archivedFilter: config.archivedFilter,
        expandedGroups: {},
        manualOrders: {},
        ungroupedOrder: [],
      }
      try {
        const raw = localStorage.getItem(VIEW_KEY)
        if (raw === null) return fallback
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return fallback
        return {
          groupBy: parsed.groupBy ?? fallback.groupBy,
          orderBy: parsed.orderBy ?? fallback.orderBy,
          archivedFilter: parsed.archivedFilter ?? fallback.archivedFilter,
          expandedGroups: parsed.expandedGroups ?? {},
          manualOrders: parsed.manualOrders ?? {},
          ungroupedOrder: Array.isArray(parsed.ungroupedOrder) ? parsed.ungroupedOrder : [],
        }
      } catch {
        return fallback
      }
    }

    /** 写入本地视图状态（静默失败）。 */
    function writeViewState(state) {
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(state))
      } catch { /* 配额或隐私模式：忽略 */ }
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 组件
     * ══════════════════════════════════════════════════════════════════════ */

    /** 官方 Tooltip 的降级实现：直接渲染 children。 */
    function TooltipFallback({ children }) {
      return children ?? null
    }

    /** 官方 StateDot 的降级实现：一个带 data-state 的小圆点。 */
    function StateDotFallback({ state }) {
      const ongoing = state === 'ongoing'
      return h('span', {
        'aria-hidden': 'true',
        'data-dsh-fso-dot': state,
        style: {
          flex: 'none',
          display: 'inline-block',
          width: ongoing ? 14 : 10,
          height: ongoing ? 14 : 10,
          borderRadius: '50%',
          // token 名以官方 ui-theme 的定义为准：warning 是 `state-warn-primary`。
          background: state === 'warning'
            ? 'var(--dsw-alias-state-warn-primary)'
            : state === 'done'
              ? 'var(--dsw-alias-state-business-primary)'
              : state === 'ongoing'
                ? 'transparent'
                : 'var(--dsw-alias-label-tertiary)',
          border: ongoing ? '2px solid var(--dsw-alias-label-tertiary)' : 'none',
        },
      })
    }

    /** 官方 HoverCard 的降级实现：只渲染 anchor（不弹卡）。 */
    function HoverCardFallback({ anchor }) {
      return anchor ?? null
    }

    /** 行内时间：`刚刚` 不加「前」，其余走 `{n}分钟` 等紧凑格式（官方 timeLabel）。 */
    function timeLabel(updatedAt, now, t) {
      const bucket = typeof P.relativeTime === 'function'
        ? P.relativeTime(updatedAt, now)
        : relativeTimeBucket(updatedAt, now)
      return bucket.unit === 'now' ? t('time.now') : t(`time.${bucket.unit}`, { n: bucket.n })
    }

    /** 悬停卡时间：除 `刚刚` 外都包一层「{t}前」（官方 hoverTimeLabel）。 */
    function hoverTimeLabel(updatedAt, now, t) {
      const bucket = typeof P.relativeTime === 'function'
        ? P.relativeTime(updatedAt, now)
        : relativeTimeBucket(updatedAt, now)
      return bucket.unit === 'now'
        ? t('time.now')
        : t('time.ago', { t: t(`time.${bucket.unit}`, { n: bucket.n }) })
    }

    /** 标题超出不到这么多像素就不跑马灯（官方的 MIN_TITLE_REVEAL_PX）。 */
    const MIN_TITLE_REVEAL_PX = 8
    /** 跑马灯速度：px/ms（官方的 TITLE_MARQUEE_PX_PER_MS）。 */
    const TITLE_MARQUEE_PX_PER_MS = 0.03

    /**
     * 把标题滚到指定偏移，并同步两侧渐隐遮罩的 data 属性。
     * @param {HTMLElement} title
     * @param {number} left - 滚动偏移（px）。
     * @param {number} range - 最大滚动偏移（px）。
     */
    function placeTitle(title, left, range) {
      if (typeof title.scrollTo === 'function') title.scrollTo({ left, behavior: 'instant' })
      else title.scrollLeft = left
      if (left > 0) title.dataset.scrolled = ''
      else delete title.dataset.scrolled
      if (left < range) title.dataset.clipped = ''
      else delete title.dataset.clipped
    }

    /** 标题回到起始状态，遮罩全部关闭（官方 restTitle）。 */
    function restTitle(title) {
      if (typeof title.scrollTo === 'function') title.scrollTo({ left: 0, behavior: 'instant' })
      else title.scrollLeft = 0
      delete title.dataset.scrolled
      delete title.dataset.clipped
    }

    /**
     * 悬停时让过长的标题横向滚动，露出末端（复刻官方 `useTitleMarquee`）。
     *
     * 语义要点：
     *   · 溢出不足 8px 不动（几像素的抖动读起来是抖动，不是揭示）；
     *   · 匀速 0.03px/ms 滚到末端后停住；
     *   · 减少动效时直接跳到末端；
     *   · 离开时一步回到起点（否则省略号会与文本在回程中相遇）。
     *
     * @param {{current: HTMLElement|null}} title - 标题元素的 ref。
     * @returns {{enter: () => void, leave: () => void}}
     */
    function useTitleMarquee(title) {
      const frame = react.useRef(0)
      react.useEffect(() => () => { cancelAnimationFrame(frame.current) }, [])

      return react.useMemo(() => ({
        enter: () => {
          const element = title.current
          if (element === null) return
          const range = element.scrollWidth - element.clientWidth
          if (range <= MIN_TITLE_REVEAL_PX) return
          if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) {
            placeTitle(element, range, range)
            return
          }
          cancelAnimationFrame(frame.current)
          let previous
          let position = 0
          const step = now => {
            position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
            previous = now
            placeTitle(element, Math.min(position, range), range)
            if (position < range) frame.current = requestAnimationFrame(step)
          }
          frame.current = requestAnimationFrame(step)
        },
        leave: () => {
          cancelAnimationFrame(frame.current)
          if (title.current === null) return
          restTitle(title.current)
        },
      }), [title])
    }

    /**
     * 状态点 + 无障碍文本（复刻官方 `SessionStatusDots`）。
     */
    function SessionStatusDots({ statuses }) {
      const StateDot = P.StateDot ?? StateDotFallback
      return h(
        react.Fragment,
        null,
        h(StateDot, { state: statuses[0].state }),
        statuses.map(status =>
          h('span', {
            key: status.label,
            style: {
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
            },
          }, status.label),
        ),
      )
    }

    /**
     * 视图选项菜单（复刻官方 `ViewOptionsMenu`）。
     *
     * 三组：分组方式 / 排序方式 / 筛选会话。
     */
    function ViewOptionsMenu({ groupBy, orderBy, archivedFilter, onGroupPick, onOrderPick, onArchivedFilterPick, t }) {
      const [open, setOpen] = react.useState(false)
      const Menu = P.Menu
      const Tooltip = P.Tooltip ?? TooltipFallback

      const anchor = h(
        Tooltip,
        { label: t('viewOptions.label'), side: 'bottom', delayMs: 500, children: h('button', {
          type: 'button',
          'data-dsh-fso-icon-button': '',
          'aria-label': t('viewOptions.label'),
          onClick: () => { setOpen(v => !v) },
        }, h(Icons.sliders, { size: 16 })) },
      )

      // 官方 primitives 不可用时，只渲染锚点按钮（菜单不可用），避免半截 UI。
      if (Menu === undefined) return anchor

      return h(Menu, {
        open,
        onClose: () => { setOpen(false) },
        items: [
          { type: 'label', id: 'group-by', text: t('groupBy.label') },
          { id: 'workspace', label: t('groupBy.workspace'), icon: h(Icons.folderClose, {}) },
          { id: 'workspace-tree', label: t('groupBy.workspaceTree'), icon: h(Icons.tree, {}) },
          { id: 'flat', label: t('groupBy.flat'), icon: h(Icons.flatList, {}) },
          { type: 'separator', id: 'order-by-separator' },
          { type: 'label', id: 'order-by', text: t('orderBy.label') },
          { id: 'manual', label: t('orderBy.manual'), icon: h(Icons.updown, {}) },
          { id: 'updated', label: t('orderBy.updated'), icon: h(Icons.clock, {}) },
          { type: 'separator', id: 'archived-filter-separator' },
          { type: 'label', id: 'filter-by', text: t('filterBy.label') },
          { id: 'hide-archived', label: t('viewOptions.hideArchived'), icon: h(Icons.archiveOff, {}) },
          { id: 'show-archived', label: t('viewOptions.showArchived'), icon: h(Icons.queue, {}) },
          { id: 'only-archived', label: t('viewOptions.onlyArchived'), icon: h(Icons.archiveCheck, {}) },
        ],
        selectedIds: [
          groupBy,
          orderBy,
          { default: 'hide-archived', show: 'show-archived', only: 'only-archived' }[archivedFilter],
        ],
        onSelect: id => {
          if (id === 'workspace' || id === 'workspace-tree' || id === 'flat') onGroupPick(id)
          else if (id === 'manual' || id === 'updated') onOrderPick(id)
          else if (id === 'hide-archived') onArchivedFilterPick('default')
          else if (id === 'show-archived') onArchivedFilterPick('show')
          else if (id === 'only-archived') onArchivedFilterPick('only')
          setOpen(false)
        },
        align: 'end',
        dense: true,
        portal: true,
        anchor,
      })
    }

    /**
     * 会话行的「...」菜单（复刻官方默认四项：置顶 / 重命名 / 分叉 / 归档）。
     *
     * 官方把这几项做成 `sidebar.workspaces.session.menu.item` 的 slot 条目；本插件
     * 无法渲染官方声明的子座位（见文件头），所以在这里内联实现同样的四项。
     */
    function SessionRowMenu({ node, open, onClose, onRename, onFork, onPin, onArchive, onUnarchive, t }) {
      const Menu = P.Menu
      const MenuItemButton = P.MenuItemButton
      const Tooltip = P.Tooltip ?? TooltipFallback
      const title = rowDisplayTitle(node, t)

      const anchor = h(
        Tooltip,
        { label: t('actions.session.aria', { name: title }), delayMs: 500, children: h('button', {
          type: 'button',
          'data-dsh-fso-icon-button': '',
          'aria-label': t('actions.session.aria', { name: title }),
          onClick: event => { event.stopPropagation(); onClose(!open) },
        }, h(Icons.ellipsis, {})) },
      )

      if (Menu === undefined || MenuItemButton === undefined) return anchor

      const rows = []
      if (node.archived === true) {
        rows.push(h(MenuItemButton, {
          key: 'unarchive',
          icon: h(Icons.unarchive, { size: 16 }),
          onSelect: () => { onClose(false); onUnarchive(node.id) },
        }, t('menu.unarchiveSession')))
      } else {
        rows.push(h(MenuItemButton, {
          key: 'pin',
          icon: h(Icons.pin, { size: 16 }),
          onSelect: () => { onClose(false); onPin(node.id) },
        }, t(node.pinned === true ? 'menu.unpinSession' : 'menu.pinSession')))
      }
      rows.push(h(MenuItemButton, {
        key: 'rename',
        icon: h(Icons.edit, { size: 16 }),
        onSelect: () => { onClose(false); onRename(node.id, title) },
      }, t('menu.renameSession')))
      if (node.blank !== true) {
        rows.push(h(MenuItemButton, {
          key: 'fork',
          icon: h(Icons.branch, { size: 16 }),
          onSelect: () => { onClose(false); onFork(node.id) },
        }, t('menu.fork')))
      }
      if (node.archived !== true) {
        rows.push(h(MenuItemButton, {
          key: 'archive',
          separatorBefore: true,
          danger: true,
          icon: h(Icons.archive, { size: 16 }),
          onSelect: () => { onClose(false); onArchive(node.id, title) },
        }, t('menu.archiveSession')))
      }

      return h(Menu, {
        open,
        onClose: () => { onClose(false) },
        portal: true,
        closeOnPointerLeave: true,
        anchor,
        children: rows,
      })
    }

    /**
     * 会话行 hover 时的行内操作按钮（复刻官方 `*SessionRowButton`）。
     *
     * 官方三个行内按钮共用同一套外观与交互：
     *   · Tooltip 包住一个 16×16 的 `iconButton`（`Rows.module.css` 里
     *     `radius-xs`、色 `label-tertiary`，hover 转 `label-primary`）；
     *   · Tooltip 的 side 是 `bottom`、align 是 `end`、delayMs 500；
     *   · `aria-label` 用**菜单项**的文案（`menu.pinSession` 等），而 Tooltip
     *     用**动作**文案（`actions.pin` 等）—— 官方就是这么分的，别合并。
     *
     * @param {{icon: Function, label: string, ariaLabel: string, onActivate: Function, t: Function}} props
     */
    function SessionRowActionButton({ icon, label, ariaLabel, onActivate }) {
      const Tooltip = P.Tooltip ?? TooltipFallback
      return h(Tooltip, {
        label,
        side: 'bottom',
        align: 'end',
        delayMs: 500,
        children: h('button', {
          type: 'button',
          'data-dsh-fso-icon-button': '',
          'aria-label': ariaLabel,
          onClick: event => { event.stopPropagation(); onActivate() },
        }, h(icon, { size: 14 })),
      })
    }

    /**
     * 会话行的悬停卡内容（复刻官方 `SessionHoverContent`）。 */
    function SessionHoverContent({ node, now, t }) {
      const StateDot = P.StateDot ?? StateDotFallback
      const statuses = sessionStatuses(node, t)
        .filter(status => !(node.archived === true && (status.state === 'done' || status.state === 'idle')))
      return h(
        'div',
        { 'data-dsh-fso-hover-content': '' },
        h('div', { 'data-dsh-fso-hover-title': '' }, rowDisplayTitle(node, t)),
        node.blank !== true && h('div', { 'data-dsh-fso-hover-time': '' }, hoverTimeLabel(node.updatedAt, now, t)),
        statuses.map(status =>
          h('div', { key: status.label, 'data-dsh-fso-hover-status': '' },
            h(StateDot, { state: status.state }),
            h('span', null, status.label),
          ),
        ),
        node.archived === true && h('div', { 'data-dsh-fso-hover-status': '' },
          h(Icons.archive, { size: 14 }),
          h('span', null, t('row.archived')),
        ),
      )
    }

    /** 工作区行的悬停卡内容（复刻官方 `WorkspaceHoverContent`）。 */
    function WorkspaceHoverContent({ group, home, t }) {
      const created = Number.isFinite(group.createdAt) && group.createdAt > 0
        ? new Date(group.createdAt)
        : undefined
      // 官方用字典里的 date.ymd 模板，而不是 toLocaleString —— 后者跟随浏览器
      // 语言，切换应用语言后会产出混合语言文本。
      const timeText = created === undefined
        ? undefined
        : t('date.ymd', {
            y: created.getFullYear(),
            m: created.getMonth() + 1,
            d: created.getDate(),
          })
      return h(
        'div',
        { 'data-dsh-fso-hover-content': '' },
        h('div', { 'data-dsh-fso-hover-title': '' }, group.label),
        group.cwd !== undefined && h('div', { 'data-dsh-fso-hover-path': '' }, abbreviateHomePath(group.cwd, home)),
        timeText !== undefined && h('div', { 'data-dsh-fso-hover-time': '' }, t('hover.created', { time: timeText })),
      )
    }

    /**
     * 一条会话行（复刻官方 `SessionNodeItem`）。
     *
     * 从左到右：状态点槽（16px）→ 标题 → 相对时间 → 置顶标记 → hover 操作区。
     */
    function SessionRow({ node, currentId, now, limitKey, onOpen, onRename, onFork, onPin, onArchive, onUnarchive, onDragStart, onDragOver, onDrop, dropMarker, dragging, t }) {
      const [menuOpen, setMenuOpen] = react.useState(false)
      const HoverCard = P.HoverCard ?? HoverCardFallback
      const StateDot = P.StateDot ?? StateDotFallback
      const title = rowDisplayTitle(node, t)
      const selected = node.id === currentId
      const statuses = sessionStatuses(node, t)
      const primaryStatus = statuses[0]
      const showStatus = primaryStatus.state !== 'idle'
      const draggable = node.blank !== true && node.archived !== true
      /** 悬停跑马灯：标题过长时横滚露出末端（官方 useTitleMarquee）。 */
      const titleRef = react.useRef(null)
      const marquee = useTitleMarquee(titleRef)

      const anchor = h(
        'div',
        {
          'data-dsh-fso-session-row': '',
          ...(selected ? { 'data-selected': '' } : {}),
          ...(node.archived ? { 'data-archived': '' } : {}),
          ...(menuOpen ? { 'data-menu-open': '' } : {}),
          ...(dropMarker !== undefined ? { 'data-drop': dropMarker } : {}),
          ...(dragging ? { 'data-dragging': '' } : {}),
          role: 'treeitem',
          'aria-selected': selected,
          title,
          onClick: () => { onOpen(node.id) },
          onPointerEnter: marquee.enter,
          onPointerLeave: marquee.leave,
          draggable,
          onDragStart: !draggable ? undefined : event => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', node.id)
            onDragStart(node.id, limitKey)
          },
          onDragOver: !draggable ? undefined : event => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            onDragOver(node.id, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
          },
          onDrop: !draggable ? undefined : event => {
            event.preventDefault()
            onDrop()
          },
        },
        h('span', { 'data-dsh-fso-slot': '' },
          node.archived !== true && node.blank !== true && (showStatus
            ? h(SessionStatusDots, { statuses })
            : null),
        ),
        h('span', {
          ref: titleRef,
          'data-dsh-fso-title': '',
          onDoubleClick: node.blank ? undefined : event => {
            event.stopPropagation()
            onRename(node.id, title)
          },
        }, title),
        node.blank !== true && h('span', {
          'data-dsh-fso-time': '',
          ...(primaryStatus.trailingLabel === undefined ? {} : { 'aria-hidden': 'true' }),
        }, primaryStatus.trailingLabel ?? timeLabel(node.updatedAt, now, t)),
        node.pinned === true && node.archived !== true && h('span', {
          'data-dsh-fso-pin': '',
          role: 'img',
          'aria-label': t('row.pinned'),
          title: t('row.pinned'),
        }, h(Icons.pin, { size: 14 })),
        node.blank !== true && h('span', {
          'data-dsh-fso-row-actions': '',
          onClick: event => { event.stopPropagation() },
        },
          /* 官方 hover 操作区的**排列顺序**（来自官方 SessionNodeItem 的 children
           * 顺序 + `sidebar.workspaces.session.row.action` 各条目的 order）：
           *
           *   「...」菜单  →  archive(100)  →  pin(200)      ← 从左到右
           *
           * 注意菜单在**最左**，不是最右：官方先渲染 Menu、再渲染 row.action 座位。
           * pin 排在最右是有意的 —— 它正好落在静止态那个置顶标记
           * （pinIndicator）的位置上，所以 hover 时视觉不跳。
           *
           * 归档行：archive 按钮变成「取消归档」；pin 按钮**整块不渲染**
           * （官方 PinSessionRowButton 在 archived 时 return null —— 置顶与归档
           * 在 Host 侧互斥）。
           *
           * 空白行：官方 `!row.blank &&` 直接不渲染整个操作区，这里同样处理。 */
          h(SessionRowMenu, {
            node, open: menuOpen,
            onClose: setMenuOpen,
            onRename, onFork, onPin, onArchive, onUnarchive, t,
          }),
          h(SessionRowActionButton, {
            key: 'archive',
            icon: node.archived === true ? Icons.unarchive : Icons.archive,
            label: t(node.archived === true ? 'actions.unarchive' : 'actions.archive'),
            ariaLabel: t(node.archived === true ? 'menu.unarchiveSession' : 'menu.archiveSession'),
            onActivate: () => {
              if (node.archived === true) onUnarchive(node.id)
              else onArchive(node.id, title)
            },
          }),
          node.archived !== true && h(SessionRowActionButton, {
            key: 'pin',
            icon: node.pinned === true ? Icons.pin : Icons.pinOutline,
            label: t(node.pinned === true ? 'actions.unpin' : 'actions.pin'),
            ariaLabel: t(node.pinned === true ? 'menu.unpinSession' : 'menu.pinSession'),
            onActivate: () => { onPin(node.id, node.pinned === true) },
          }),
        ),
      )

      return h(HoverCard, {
        anchor,
        content: h(SessionHoverContent, { node, now, t }),
        openDelayMs: 800,
        disabled: menuOpen || dragging,
        copyText: node.blank === true || node.title === '' ? undefined : node.title,
        copyLabel: t('copy'),
        copiedLabel: t('hover.copied'),
      })
    }

    /**
     * 一条工作区行（复刻官方 `ProjectRowItem`）。
     *
     * hover 时文件夹图标换成展开箭头；操作区含「...」菜单与「新会话」按钮。
     */
    function ProjectRow({ group, expanded, active, newShortcut, onToggle, onNewSession, onRename, onDelete, onDragStart, onDragOver, onDrop, dropMarker, dragging, home, t }) {
      const [menuOpen, setMenuOpen] = react.useState(false)
      const HoverCard = P.HoverCard ?? HoverCardFallback
      const Menu = P.Menu
      const MenuItemButton = P.MenuItemButton
      const Tooltip = P.Tooltip ?? TooltipFallback

      const menuAnchor = h(
        Tooltip,
        { label: t('actions.workspace.aria', { name: group.label }), delayMs: 500, children: h('button', {
          type: 'button',
          'data-dsh-fso-icon-button': '',
          'aria-label': t('actions.workspace.aria', { name: group.label }),
          onClick: event => { event.stopPropagation(); setMenuOpen(v => !v) },
        }, h(Icons.ellipsis, {})) },
      )

      /* 「未分组」桶不是工作区：它没有 workspaceId（buildGroups 给的是
       * `workspaceId: undefined`）。官方 `ProjectRowItem` 用
       * `actions: group.workspaceId === void 0 ? void 0 : {...}` 让这一行
       * **完全没有**「...」菜单；这里必须同款处理，否则菜单会把
       * `undefined` 当 workspaceId 发给 workspaceController，Host 边界校验
       * 直接拒绝（`wire field "request" failed boundary validation`）。 */
      const isWorkspace = group.workspaceId !== undefined && group.workspaceId !== null
      const menu = !isWorkspace
        ? null
        : (Menu === undefined || MenuItemButton === undefined)
          ? menuAnchor
          : h(Menu, {
              open: menuOpen,
              onClose: () => { setMenuOpen(false) },
              portal: true,
              closeOnPointerLeave: true,
              anchor: menuAnchor,
              children: [
                h(MenuItemButton, {
                  key: 'rename',
                  icon: h(Icons.edit, { size: 16 }),
                  onSelect: () => { setMenuOpen(false); onRename(group.workspaceId, group.label) },
                }, t('menu.renameWorkspace')),
                h(MenuItemButton, {
                  key: 'delete',
                  separatorBefore: true,
                  danger: true,
                  icon: h(Icons.trash, { size: 16 }),
                  onSelect: () => { setMenuOpen(false); onDelete(group.workspaceId, group.label) },
                }, t('menu.deleteWorkspace')),
              ],
            })

      const row = h(
        'div',
        {
          'data-dsh-fso-project-row': '',
          ...(menuOpen ? { 'data-menu-open': '' } : {}),
          ...(dropMarker !== undefined ? { 'data-drop': dropMarker } : {}),
          ...(dragging ? { 'data-dragging': '' } : {}),
          role: 'treeitem',
          'aria-expanded': expanded,
          onClick: () => { onToggle(group.key, !expanded) },
          draggable: group.workspaceId !== undefined,
          onDragStart: group.workspaceId === undefined ? undefined : event => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', group.workspaceId)
            onDragStart(group.workspaceId, group.key)
          },
          onDragOver: group.workspaceId === undefined ? undefined : event => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            onDragOver(group.workspaceId, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
          },
          onDrop: group.workspaceId === undefined ? undefined : event => {
            event.preventDefault()
            onDrop()
          },
        },
        h('span', {
          'data-dsh-fso-slot': '',
          'data-dsh-fso-folder': '',
          ...(active ? { 'data-active': '' } : {}),
        }, h(expanded ? Icons.folderOpen : Icons.folderClose, { size: 16 })),
        // 官方 chevron 也带 slot 类（与 folder 同为 16px 槽位），hover 时二者互换，
        // 所以宽度一致、不会产生布局跳动。
        h('span', {
          'data-dsh-fso-slot': '',
          'data-dsh-fso-chevron': '',
          ...(expanded ? { 'data-open': '' } : {}),
        }, h(Icons.chevron, { size: 10 })),
        // 官方标题在 projectText 里（flex column 容器），不是直接裸 span。
        h('span', { 'data-dsh-fso-project-text': '' },
          h('span', { 'data-dsh-fso-title': '' }, group.label),
        ),
        h('span', { 'data-dsh-fso-row-actions': '', onClick: event => { event.stopPropagation() } },
          menu,
          group.workspaceId !== undefined && h(
            Tooltip,
            {
              label: t('actions.newSession'),
              shortcutKeys: newShortcut?.keys,
              side: 'bottom',
              align: 'end',
              delayMs: 500,
              children: h('button', {
                type: 'button',
                'data-dsh-fso-icon-button': '',
                'aria-keyshortcuts': newShortcut?.aria,
                'aria-label': t('actions.newSession.aria', { name: group.label }),
                onClick: event => { event.stopPropagation(); onNewSession(group.workspaceId) },
              }, h(Icons.newChat, {})) },
          ),
        ),
      )

      // 未分组桶没有创建时间与路径，官方也不给它悬停卡。
      if (group.cwd === undefined) return row
      return h(HoverCard, {
        anchor: row,
        content: h(WorkspaceHoverContent, { group, home, t }),
        openDelayMs: 800,
        disabled: menuOpen,
        copyText: group.cwd,
        copyLabel: t('copy'),
        copiedLabel: t('hover.copied'),
      })
    }

    /**
     * 「添加工作区」流程（复刻官方 `WorkspacePickFlow`）。
     *
     * 官方交互：点区头「+」→ 弹出 Menu（列出已有工作区，footer 固定
     * 「添加工作区…」）→ 选「添加工作区…」→ 走目录选择 → 登记失败时弹错的
     * 错误框，框内「重新选择」可再次打开流程。
     *
     * 本插件没有官方的目录流 slot（`sidebar.workspaces.directoryFlow` 被官方
     * browser 独占），所以直接用 `pickDirectory()` 拿到原生选择器的结果，
     * `-browse` 组合的应用内浏览对话框不可用。
     */
    function AddWorkspaceFlow({ open, onClose, workspaces, createWorkspace, pickDirectory, phase, notify, anchor, t }) {
      const Menu = P.Menu
      const Modal = P.Modal
      const Button = P.Button
      const [flowOpen, setFlowOpen] = react.useState(false)
      const [picking, setPicking] = react.useState(false)
      const [errorOpen, setErrorOpen] = react.useState(false)
      const [modalError, setModalError] = react.useState(null)
      const flowBusy = flowOpen || picking

      /** 目录选择可用（原生后端或 remote.directoryPicker 都算可用）。 */
      const flowAvailable = typeof pickDirectory === 'function' && pickDirectory !== null

      const addEntries = flowAvailable
        ? [{
            id: '::add-workspace',
            label: t('menu.addWorkspace'),
            icon: h(P.IconPlusOutlineRegular ?? Icons.projectAdd, { size: 16 }),
            disabled: flowBusy,
          }]
        : []

      /** `addOnly` 语义：本插件只用它来添加，所以永远 pinAdd = false。 */
      const items = addEntries
      const menuIsEmpty = items.length === 0
      const listSettled = phase === 'ready'
      // 只有「添加工作区…」一个条目时直接打开目录流（官方行为）。
      const addIsTheOnlyEntry = listSettled && addEntries.length === 1

      const adoptDirectory = react.useCallback(path => {
        Promise.resolve(createWorkspace({ path }))
          .then(() => { setFlowOpen(false) })
          .catch(reason => {
            setModalError(reason instanceof Error ? reason.message : String(reason))
            setFlowOpen(false)
            setErrorOpen(true)
          })
      }, [createWorkspace])

      /** 打开目录流：拿到路径就登记。 */
      const openDirectoryFlow = react.useCallback(() => {
        onClose()
        setErrorOpen(false)
        setModalError(null)
        setFlowOpen(true)
        setPicking(true)
        Promise.resolve()
          .then(() => pickDirectory())
          .then(path => {
            if (path === null || path === undefined || path === '') return
            return void adoptDirectory(path)
          })
          .catch(reason => {
            setModalError(reason instanceof Error ? reason.message : String(reason))
            setErrorOpen(true)
          })
          .finally(() => { setPicking(false); setFlowOpen(false) })
      }, [onClose, pickDirectory, adoptDirectory])

      react.useEffect(() => {
        if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
      }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

      const closeModal = react.useCallback(() => {
        setErrorOpen(false)
        setModalError(null)
      }, [])

      const handleSelect = id => {
        if (id === '::add-workspace') {
          openDirectoryFlow()
          return
        }
        // 选中一个已有工作区：本插件没有「在里面新建会话」的入口，
        // 选中即展开/聚焦该分组由调用方负责，这里直接关菜单。
        onClose()
      }

      if (Menu === undefined) return anchor ?? null

      return h(
        react.Fragment,
        null,
        /** 锚点按钮由调用方提供；Menu 用 portal + anchor 元素本身定位。 */
        anchor ?? null,
        h(Menu, {
          open: open && !addIsTheOnlyEntry && !menuIsEmpty,
          anchor,
          items,
          onSelect: handleSelect,
          onClose,
          side: 'bottom',
          portal: true,
        }),
        open && !addIsTheOnlyEntry && !menuIsEmpty && phase === 'pending' && h('div', {
          'data-dsh-fso-modal-status': '',
          role: 'status',
        }, t('picker.loading')),
        Modal !== undefined && h(Modal, {
          open: errorOpen,
          onClose: closeModal,
          closeLabel: t('close'),
          title: t('folderError.title'),
          footer: h(react.Fragment, null,
            h(Button ?? 'button', { variant: 'outline', 'data-dsh-fso-modal-action': '', onClick: closeModal }, t('cancel')),
            h(Button ?? 'button', {
              variant: 'outline',
              'data-dsh-fso-modal-action': '',
              onClick: () => { closeModal(); openDirectoryFlow() },
            }, t('folderError.retry')),
          ),
          children: [
            modalError !== null && h('div', { key: 'error', 'data-dsh-fso-modal-error': '', role: 'alert' }, modalError),
          ],
        }),
      )
    }

    /** 空状态（复刻官方 `EmptySessions`）。 */
    function EmptyState({ archivedOnly, onShowOthers, t }) {
      if (archivedOnly === true) {
        return h('div', { 'data-dsh-fso-empty': '' },
          h(Icons.archive, { size: 24 }),
          h('div', null, t('empty.noneArchived')),
          h('button', {
            type: 'button',
            'data-dsh-fso-empty-action': '',
            onClick: onShowOthers,
          }, t('empty.viewOthers')),
        )
      }
      return h('div', { 'data-dsh-fso-empty': '' },
        h(Icons.queue, { size: 24 }),
        h('div', null, t('empty.none')),
      )
    }

    /**
     * 把 slot 条目的 inject 面绑定成可直接展开给组件的 props。
     *
     * 渲染器（ui-renderer `bindInjectSources`）对每个条目做的就是这件事：
     *   · `hooks: { account }` → `useAccount`（`standardHookPropName` 规则）
     *   · 其余字段（signOut / start / cancel / contactUs …）原样展开
     * 本插件不经过渲染器渲染该条目（见 `resolveAccountEntry` 的说明），
     * 所以在这里照同一套规则补一次，行为与官方座位里完全一致。
     *
     * hook 用 `useSyncExternalStore` 直接桥接 observable source：
     * 官方用的是 zustand 的 `useSyncExternalStoreWithSelector`，两者语义
     * 一致（selector 在渲染期应用，source 快照本身是稳定引用）。
     */
    function makeObservableHook(source) {
      const subscribe = fn => source.subscribe(fn)
      const getSnapshot = () => source.getSnapshot()
      const useSyncExternalStore = react.useSyncExternalStore
      return function useSelector(selector) {
        // React 18 之前 / 测试桩没有 useSyncExternalStore：直接读快照，
        // 退化成「不订阅」，渲染仍然正确（只是不会自动跟着账户变化重渲）。
        if (typeof useSyncExternalStore !== 'function') {
          const value = getSnapshot()
          return typeof selector === 'function' ? selector(value) : value
        }
        const whole = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        return typeof selector === 'function' ? selector(whole) : whole
      }
    }

    /** `standardHookPropName`：`account` → `useAccount`。 */
    const hookPropName = name => `use${String(name)[0]?.toUpperCase() ?? ''}${String(name).slice(1)}`

    /**
     * 绑定一个 slot 条目的 inject 面。
     * @param {object} entry - `slots.entriesOfSlot(...)` 里的条目。
     */
    function bindEntryFace(entry) {
      let face
      try {
        face = typeof entry?.inject === 'function' ? entry.inject() : {}
      } catch (error) {
        console.warn('[sidebar-overlay] 账户入口 inject 失败:', error?.message ?? error)
        face = {}
      }
      const { hooks, keyedHooks: _keyedHooks, ...props } = face ?? {}
      const bound = { ...props }
      for (const [name, source] of Object.entries(hooks ?? {})) {
        if (source === undefined || source === null || typeof source.subscribe !== 'function') continue
        bound[hookPropName(name)] = makeObservableHook(source)
      }
      return bound
    }

    /**
     * 取官方账户数据源（`settings.launcher` 条目 inject 出来的 `account` hook）。
     *
     * 账户状态（是否登录、昵称、头像）全部封装在 `ui-settings-account` 内部：
     * 它既没有 `provideRoot`，也没有对外暴露服务。唯一稳定的公开面是官方
     * 自己声明的 `settings.launcher` 座位 —— 官方 `SettingsRoot` 就是
     *
     *     renderSlot("settings.launcher", { wide, settingsOpen, openSettings, ... })
     *
     * 把它渲染出来的。本插件渲染不了那个座位（`renderSlot` 的授权绑定在
     * 声明者 `sidebar.settings` 的条目上，见文件头），但可以取出条目、
     * 读它的 `inject()` 面，拿到**同一份**账户 observable source。
     *
     * @param {object} slots - `ctx.slots` 服务。
     * @returns {object|undefined} `{ component, face }`；取不到时 undefined。
     */
    function resolveAccountEntry(slots) {
      try {
        if (slots === undefined || slots === null || typeof slots.entriesOfSlot !== 'function') return undefined
        const entry = slots.entriesOfSlot('settings.launcher')[0]
        if (entry === undefined || typeof entry.inject !== 'function') return undefined
        const face = entry.inject()
        const source = face?.hooks?.account
        if (source === undefined || source === null || typeof source.subscribe !== 'function') return undefined
        return { source }
      } catch {
        return undefined
      }
    }

    /**
     * 打开官方设置弹窗。
     *
     * ⚠️ **不能用 `ctx.shortcuts.invoke('settings.open')`**。`ShortcutsService`
     * 只暴露 `register` / `registerFixed` / `observeFixedInput` /
     * `describeBinding`；`invoke` 在它内部的 `ShortcutRegistry` 上，第三方拿不到。
     * 写成 `shortcuts?.invoke?.(...)` 会**静默失败** —— 不报错、不告警，点了没反应。
     * 这正是「点头像 → 点设置打不开弹窗」的根因。
     *
     * 正确路径是官方 `sidebar.settings` 条目的 `store`。ui-settings-general 用
     * `createSettingsShellStore()` 声明它（状态 `{ open, activeId }` +
     * `actions.open/close/select/openSection`），官方自己点「设置」走的也是
     * `actions.open()`。store 挂在 `sidebar.settings` 条目上（不是
     * `settings.launcher`），所以要查前者。
     *
     * 能拿到**同一个**实例，靠的是 ui-settings-general 注册时的覆写：
     *
     *     const shellInstance = shellHandle.create()
     *     const shellStore = { ...shellHandle, create: () => shellInstance }
     *
     * 也就是说这里的 `handle.create()` 一定返回设置弹窗正在读的那一份，
     * `actions.open()` 必然反映到界面上。
     *
     * @param {object} slots - `ctx.slots`
     * @returns {Function|undefined} 打开设置的函数；取不到时 undefined。
     */
    function resolveOpenSettings(slots) {
      try {
        if (slots === undefined || slots === null || typeof slots.entriesOfSlot !== 'function') return undefined
        const entry = slots.entriesOfSlot('sidebar.settings')[0]
        const handle = entry?.store
        if (handle === undefined || typeof handle.create !== 'function') return undefined
        const instance = handle.create()
        const actions = instance?.actions
        if (actions === undefined || typeof actions.open !== 'function') return undefined
        return () => {
          try {
            actions.open()
            return true
          } catch (error) {
            console.warn('[sidebar-overlay] 打开设置失败:', error?.message ?? error)
            return false
          }
        }
      } catch {
        return undefined
      }
    }

    /**
     * 个人信息按钮：浮层顶部、新会话按钮左边的账户入口。
     *
     * **点击直接打开官方设置弹窗**，不再弹官方账户菜单（那是侧边栏底部那个
     * 入口的行为）。需求明确：这一行只做「设置」一件事，「联系我们」与
     * 「退出登录」不再出现。
     *
     * 外观仍是官方那块头像：复用 `settings.launcher` 条目 inject 出来的
     * `account` observable source（同一份账户状态，不会出现两套登录态），
     * 自己画 38×38 的圆钮 —— 因为不再渲染官方 `AccountMenu`，就不受它
     * 36×36 的尺寸约束了。
     *
     * @param {{accountSource: object, t: Function, onOpenSettings: Function}} props
     */
    function ProfileButton({ accountSource, t, onOpenSettings }) {
      const useAccount = react.useMemo(() => makeObservableHook(accountSource), [accountSource])
      const account = useAccount(state => state)
      const signedIn = account?.view?.status === 'credential-stored'
      const profile = account?.details?.profile
      const label = signedIn
        ? (profile?.status === 'ready'
            ? (profile.value?.name ?? profile.value?.contact ?? t('profile.signedIn'))
            : t('profile.signedIn'))
        : t('profile.signedOut')
      const avatarUrl = signedIn && account?.avatar?.status === 'ready' ? account.avatar.url : undefined
      return h(
        'button',
        {
          type: 'button',
          'data-dsh-fso-profile': '',
          'data-signed-in': signedIn ? '' : undefined,
          'aria-label': t('profile.openSettings'),
          title: label,
          onClick: () => { onOpenSettings() },
        },
        h(
          'span',
          { 'data-dsh-fso-profile-avatar': '' },
          avatarUrl !== undefined
            ? h('img', {
                src: avatarUrl,
                alt: '',
                referrerPolicy: 'no-referrer',
                onError: event => { event.currentTarget.style.display = 'none' },
              })
            : h(Icons.user, { size: 16 }),
        ),
      )
    }

    /**
     * 浮动侧边栏主体。
     *
     * props 由 slot 系统注入：`useSessions` / `useSessionStatus` / `useWorkspaces` /
     * `usePanelInfo` 来自官方三个包的 `provideRoot`（root scope 座位自动获得），
     * 其余是本插件 `inject` 返回的业务回调与配置。
     */
    function FloatingSidebar(props) {
      const {
        useSessions, useSessionStatus, useWorkspaces, usePanelInfo, useShortcuts,
        config, t: tInjected,
        openSession, startSession, forkSession, renameSession,
        pinSession, unpinSession, archiveSession, unarchiveSession,
        renameWorkspace, deleteWorkspace, insertWorkspaceBefore, createWorkspace,
        searchSessions, searchResultLimit, pickDirectory, hostHome, notify,
        accountSource, accountT, openSettings,
      } = props

      const merged = { ...DEFAULTS, ...(config ?? {}) }
      const t = typeof tInjected === 'function' ? tInjected : fallbackT()

      /** 视图状态：本地持久化，跨刷新保留。 */
      const [view, setView] = react.useState(() => readViewState(merged))
      const patchView = react.useCallback(patch => {
        setView(previous => {
          const next = { ...previous, ...patch }
          writeViewState(next)
          return next
        })
      }, [])

      /** 相对时间的基准时刻，每 60 秒刷新一次。 */
      const [now, setNow] = react.useState(() => Date.now())
      react.useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
        return () => { clearInterval(timer) }
      }, [])

      /* ── 数据订阅 ─────────────────────────────────────────────────────── */
      const list = typeof useSessions === 'function' ? useSessions(state => state) : undefined
      const statuses = typeof useSessionStatus === 'function' ? useSessionStatus(state => state) : undefined
      const workspaceSnapshot = typeof useWorkspaces === 'function' ? useWorkspaces(state => state) : undefined
      const panelActive = typeof usePanelInfo === 'function'
        ? usePanelInfo(info => info.activePanelId !== null)
        : false

      const workspaces = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : []
      const archived = react.useMemo(
        () => new Set(Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : []),
        [workspaceSnapshot],
      )
      const pinned = react.useMemo(
        () => new Set(Array.isArray(workspaceSnapshot?.pinnedSessionIds) ? workspaceSnapshot.pinnedSessionIds : []),
        [workspaceSnapshot],
      )

      /** 全局面板活跃时不高亮当前会话（官方行为）。 */
      const currentId = panelActive === true ? undefined : mainSessionId(list)

      /** 折叠配额：每个分组各自记录当前的空闲会话配额。 */
      const [limits, setLimits] = react.useState({})

      /* ── 搜索 ─────────────────────────────────────────────────────────── */
      const [searchExpanded, setSearchExpanded] = react.useState(false)
      const [query, setQuery] = react.useState('')
      const [remoteResults, setRemoteResults] = react.useState({ items: [], hasMore: false, loading: false })
      const searchInputRef = react.useRef(null)

      react.useEffect(() => {
        const normalized = query.trim()
        if (normalized === '') {
          setRemoteResults({ items: [], hasMore: false, loading: false })
          return undefined
        }
        const controller = new AbortController()
        setRemoteResults(previous => ({ ...previous, loading: true }))
        const timer = setTimeout(() => {
          Promise.resolve()
            .then(() => (typeof searchSessions === 'function' ? searchSessions(normalized, controller.signal) : { items: [], hasMore: false }))
            .then(result => {
              if (controller.signal.aborted) return
              setRemoteResults({
                items: Array.isArray(result?.items) ? result.items : [],
                hasMore: result?.hasMore === true,
                loading: false,
              })
            })
            .catch(() => {
              if (controller.signal.aborted) return
              // 内容搜索失败时元数据匹配仍然展示，不额外报警（官方行为）。
              setRemoteResults({ items: [], hasMore: false, loading: false })
            })
        }, SEARCH_DEBOUNCE_MS)
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [query, searchSessions])

      /** 本地元数据匹配 + 远端内容匹配的合并结果。 */
      const searchRows = react.useMemo(() => {
        const normalized = query.trim()
        if (normalized === '') return []
        const local = localSearch(list ?? {}, workspaces, normalized, {
          archived, archivedFilter: view.archivedFilter, currentId, statuses, t,
        })
        const snippetBySession = new Map()
        for (const item of remoteResults.items) {
          if (item?.sessionId !== undefined && !snippetBySession.has(item.sessionId)) {
            snippetBySession.set(item.sessionId, item.snippet)
          }
        }
        const seen = new Set()
        const merged = []
        for (const row of local) {
          seen.add(row.id)
          const snippet = snippetBySession.get(row.id)
          merged.push({ ...row, ...(snippet === undefined ? {} : { snippet }) })
        }
        for (const item of remoteResults.items) {
          const sessionId = item?.sessionId
          if (sessionId === undefined || seen.has(sessionId)) continue
          const summary = list?.byId?.[sessionId]
          if (summary === undefined) continue
          if (!sessionVisible(summary, currentId, archived, view.archivedFilter)) continue
          seen.add(sessionId)
          const workspace = workspaces.find(w => (w.sessionIds ?? []).includes(sessionId))
          merged.push({
            ...sessionNode(summary, list, statuses, pinned, archived),
            workspace: workspace === undefined ? t('group.ungrouped') : workspaceDisplayTitle(workspace.title, t),
            ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
          })
        }
        return merged.slice(0, Math.max(1, Number(searchResultLimit) || 20))
      }, [query, list, workspaces, archived, pinned, statuses, currentId, view.archivedFilter, remoteResults, searchResultLimit, t])

      const searchHasMore = remoteResults.hasMore || searchRows.length >= (Number(searchResultLimit) || 20)

      /* ── 分组派生 ─────────────────────────────────────────────────────── */
      const groups = react.useMemo(() => buildGroups(list ?? {}, workspaces, {
        archived, archivedFilter: view.archivedFilter, currentId,
        ungroupedOrder: view.ungroupedOrder, manualOrders: view.manualOrders,
        pinned, orderBy: view.orderBy, statuses, t,
      }), [list, workspaces, archived, pinned, currentId, view.archivedFilter, view.ungroupedOrder, view.manualOrders, view.orderBy, statuses, t])

      /** 单列表模式的扁平分组（仅在需要时派生）。 */
      const flat = react.useMemo(() => buildFlat(list ?? {}, {
        archived, archivedFilter: view.archivedFilter, currentId,
        ungroupedOrder: view.ungroupedOrder, pinned, orderBy: view.orderBy, statuses, t,
      }), [list, archived, pinned, currentId, view.archivedFilter, view.ungroupedOrder, view.orderBy, statuses, t])

      /** 工作区树模式：把分组按路径祖先嵌套。 */
      const tree = react.useMemo(
        () => (view.groupBy === 'workspace-tree' ? nestGroups(groups) : { roots: groups, childrenOf: new Map() }),
        [groups, view.groupBy],
      )

      /** 分组是否展开：默认展开（有当前会话的分组也默认展开）。 */
      const isExpanded = react.useCallback(key => {
        const stored = view.expandedGroups[key]
        if (stored !== undefined) return stored
        return true
      }, [view.expandedGroups])

      /** 某分组是否含当前会话（用于文件夹高亮）。 */
      const groupContainsCurrent = react.useCallback(group => {
        if (currentId === undefined) return false
        return group.sessions.some(row => row.id === currentId)
      }, [currentId])

      /* ── 拖拽 ─────────────────────────────────────────────────────────── */
      const [sessionDrag, setSessionDrag] = react.useState(null)
      /** 「添加工作区」流程的开关（区头「+」按钮控制）。 */
      const [addWorkspaceOpen, setAddWorkspaceOpen] = react.useState(false)
      const [workspaceDrag, setWorkspaceDrag] = react.useState(null)
      const [dropTarget, setDropTarget] = react.useState(null)

      const beginSessionDrag = react.useCallback((sessionId, accountKey) => {
        setSessionDrag({ sessionId, accountKey })
        setDropTarget(null)
      }, [])
      const hoverSession = react.useCallback((sessionId, marker) => {
        setDropTarget(previous => {
          if (previous?.kind === 'session' && previous.id === sessionId && previous.marker === marker) return previous
          return { kind: 'session', id: sessionId, marker }
        })
      }, [])
      const dropSession = react.useCallback(() => {
        const drag = sessionDrag
        const target = dropTarget
        setSessionDrag(null)
        setDropTarget(null)
        if (drag === null || target === null || target.kind !== 'session') return
        if (drag.sessionId === target.id) return
        const accountKey = drag.accountKey
        // 单列表模式的 key 是 `__flat__`，不在 `groups` 里，需要单独找。
        const group = accountKey === flat.key
          ? flat
          : groups.find(g => g.key === accountKey)
        if (group === undefined) return
        // 关键：基于**完整顺序**（含被归档筛选隐藏的成员）重排，否则隐藏成员会被抹掉。
        const ids = group.fullOrder
        if (!ids.includes(drag.sessionId) || !ids.includes(target.id)) return
        const without = ids.filter(id => id !== drag.sessionId)
        const anchorIndex = without.indexOf(target.id)
        if (anchorIndex < 0) return
        const insertAt = target.marker === 'before' ? anchorIndex : anchorIndex + 1
        const next = [...without.slice(0, insertAt), drag.sessionId, ...without.slice(insertAt)]
        // 记账落点必须与派生时的读取来源一致：
        //   · 未分组桶与单列表都读 `ungroupedOrder`（见 buildGroups / buildFlat）；
        //   · 真实工作区读 `manualOrders[workspaceId]`。
        const usesUngroupedOrder = accountKey === '' || accountKey === flat.key
        patchView({
          orderBy: 'manual',
          ...(usesUngroupedOrder
            ? { ungroupedOrder: next }
            : { manualOrders: { ...view.manualOrders, [accountKey]: next } }),
        })
      }, [sessionDrag, dropTarget, groups, flat, patchView, view.manualOrders])

      const beginWorkspaceDrag = react.useCallback((workspaceId, groupKey) => {
        setWorkspaceDrag({ workspaceId, groupKey })
        setDropTarget(null)
      }, [])
      const hoverWorkspace = react.useCallback((workspaceId, marker) => {
        setDropTarget(previous => {
          if (previous?.kind === 'workspace' && previous.id === workspaceId && previous.marker === marker) return previous
          return { kind: 'workspace', id: workspaceId, marker }
        })
      }, [])
      const dropWorkspace = react.useCallback(() => {
        const drag = workspaceDrag
        const target = dropTarget
        setWorkspaceDrag(null)
        setDropTarget(null)
        if (drag === null || target === null || target.kind !== 'workspace') return
        if (drag.workspaceId === target.id) return
        // 只重排同级；`insertBefore` 的语义是「插到锚点之前」。
        const ordered = workspaces.map(w => w.workspaceId)
        const without = ordered.filter(id => id !== drag.workspaceId)
        const anchorIndex = without.indexOf(target.id)
        if (anchorIndex < 0) return
        const insertAt = target.marker === 'before' ? anchorIndex : anchorIndex + 1
        const nextAnchor = without[insertAt]
        void Promise.resolve(insertWorkspaceBefore(drag.workspaceId, nextAnchor)).catch(reason => {
          notify('toast.actionFailed', { message: reason?.message ?? String(reason) })
        })
      }, [workspaceDrag, dropTarget, workspaces, insertWorkspaceBefore, notify])

      /* ── 模态框状态 ───────────────────────────────────────────────────── */
      const [renameTarget, setRenameTarget] = react.useState(null)
      const [renameDraft, setRenameDraft] = react.useState('')
      const [renameBusy, setRenameBusy] = react.useState(false)
      const [renameError, setRenameError] = react.useState(null)

      const [deleteTarget, setDeleteTarget] = react.useState(null)
      const [deleteBusy, setDeleteBusy] = react.useState(false)
      const [deleteError, setDeleteError] = react.useState(null)

      const [archiveConfirm, setArchiveConfirm] = react.useState(null)
      const [archiveBusy, setArchiveBusy] = react.useState(false)
      const [archiveError, setArchiveError] = react.useState(null)

      const openRenameSession = react.useCallback((sessionId, title) => {
        // `storedTitle` 用于「未修改则禁用确认」——官方允许确认未改动的标题
        // （这是把自动标题钉住、不再被重新生成覆盖的手势），但会话的初值取
        // 已保存标题，空标题时留空。
        setRenameTarget({ kind: 'session', sessionId, storedTitle: title ?? '' })
        setRenameDraft(title ?? '')
        setRenameError(null)
      }, [])
      const openRenameWorkspace = react.useCallback((workspaceId, label) => {
        setRenameTarget({ kind: 'workspace', workspaceId, storedTitle: label ?? '' })
        setRenameDraft(label ?? '')
        setRenameError(null)
      }, [])
      const closeRename = react.useCallback(() => {
        if (renameBusy) return
        setRenameTarget(null)
        setRenameError(null)
      }, [renameBusy])

      /* 官方的重命名校验是**渲染期派生**，不是提交时才检查：
       *   renameTrimmed   = draft.trim()
       *   renameDuplicate = 非空 && 存在别的同名工作区（精确比较，非小写化）
       *   renameBlocked   = busy || 空 || 无目标 || 未改动 || 重名
       * 重名时输入框下方实时显示提示，确认按钮禁用。 */
      const renameTrimmed = renameDraft.trim()
      const renameDuplicate = renameTarget !== null
        && renameTarget.kind === 'workspace'
        && renameTrimmed !== ''
        && workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title === renameTrimmed)
      const renameBlocked = renameBusy
        || renameTarget === null
        || renameTrimmed === ''
        || renameTrimmed === renameTarget.storedTitle
        || renameDuplicate

      const confirmRename = react.useCallback(() => {
        const target = renameTarget
        if (target === null || renameBlocked) return
        const title = renameTrimmed
        setRenameBusy(true)
        setRenameError(null)
        const operation = target.kind === 'workspace'
          ? Promise.resolve(renameWorkspace(target.workspaceId, title))
          : Promise.resolve(renameSession(target.sessionId, title))
        operation
          .then(() => { setRenameBusy(false); setRenameTarget(null) })
          .catch(reason => {
            setRenameBusy(false)
            setRenameError(reason?.message ?? String(reason))
          })
      }, [renameTarget, renameTrimmed, renameBlocked, renameWorkspace, renameSession])

      const openDeleteWorkspace = react.useCallback((workspaceId, label) => {
        setDeleteTarget({ workspaceId, label })
        setDeleteError(null)
      }, [])
      const closeDelete = react.useCallback(() => {
        if (deleteBusy) return
        setDeleteTarget(null)
        setDeleteError(null)
      }, [deleteBusy])
      const confirmDelete = react.useCallback(() => {
        const target = deleteTarget
        if (target === null) return
        setDeleteBusy(true)
        setDeleteError(null)
        Promise.resolve(deleteWorkspace(target.workspaceId))
          .then(() => { setDeleteBusy(false); setDeleteTarget(null) })
          .catch(reason => {
            setDeleteBusy(false)
            setDeleteError(reason?.message ?? String(reason))
          })
      }, [deleteTarget, deleteWorkspace])

      /**
       * 归档。
       *
       * 静止会话直接提交；仍有工作在跑时 Host 会拒绝（`workspace/session-active`），
       * 此时打开「停止并归档」确认框（官方行为）。
       */
      const doArchive = react.useCallback((sessionId, title) => {
        Promise.resolve(archiveSession(sessionId))
          .then(() => { notify('toast.archived') })
          .catch(reason => {
            const activity = reason?.rpcError?.details?.activity
            if (Array.isArray(activity) && activity.length > 0) {
              setArchiveConfirm({ sessionId, title, activity })
              setArchiveError(null)
              return
            }
            console.warn('[sidebar-overlay] 归档失败:', reason?.message ?? reason)
          })
      }, [archiveSession, notify])

      const confirmStopAndArchive = react.useCallback(() => {
        const target = archiveConfirm
        if (target === null) return
        setArchiveBusy(true)
        setArchiveError(null)
        Promise.resolve(archiveSession(target.sessionId, { stopActivity: true }))
          .then(() => {
            setArchiveBusy(false)
            setArchiveConfirm(null)
            notify('toast.stoppedAndArchived')
          })
          .catch(reason => {
            setArchiveBusy(false)
            setArchiveError(reason?.message ?? String(reason))
          })
      }, [archiveConfirm, archiveSession, notify])

      const doUnarchive = react.useCallback(sessionId => {
        Promise.resolve(unarchiveSession(sessionId))
          .catch(reason => {
            console.warn('[sidebar-overlay] 取消归档失败:', reason?.message ?? reason)
          })
      }, [unarchiveSession])

      const doPin = react.useCallback((sessionId, currentlyPinned) => {
        const operation = currentlyPinned ? unpinSession : pinSession
        Promise.resolve(operation(sessionId))
          .catch(() => { notify(currentlyPinned ? 'toast.unpinFailed' : 'toast.pinFailed') })
      }, [pinSession, unpinSession, notify])

      const doFork = react.useCallback(sessionId => {
        Promise.resolve(forkSession(sessionId))
          .catch(reason => {
            // 官方把「没有已结束轮次」与其它失败区分开。
            const unavailable = reason?.rpcError?.code === 'session/fork-unavailable'
            notify(unavailable ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed')
          })
      }, [forkSession, notify])

      const doOpen = react.useCallback(sessionId => {
        const summary = list?.byId?.[sessionId]
        if (summary !== undefined && archived.has(sessionId)) {
          notify('toast.archivedNotOpenable')
          return
        }
        openSession(sessionId)
      }, [list, archived, notify, openSession])

      /** 打开归档会话时提示，而不是导航（官方行为）。 */
      const doOpenResult = react.useCallback(row => {
        if (row.archived === true) {
          notify('toast.archivedNotOpenable')
          return
        }
        setQuery('')
        setSearchExpanded(false)
        openSession(row.id)
      }, [notify, openSession])

      /* ── 键盘：Escape 收起搜索 ────────────────────────────────────────── */
      const onSearchKeyDown = react.useCallback(event => {
        if (event.key !== 'Escape') return
        setQuery('')
        setSearchExpanded(false)
      }, [])

      react.useEffect(() => {
        if (searchExpanded) searchInputRef.current?.focus()
      }, [searchExpanded])

      /* ── 渲染 ─────────────────────────────────────────────────────────── */

      const sectionLabel = view.groupBy === 'flat' ? t('section.sessions') : t('section.workspaces')

      const header = h(
        'div',
        { 'data-dsh-fso-header': '' },
        !searchExpanded && h('span', { 'data-dsh-fso-section-label': '' }, sectionLabel),
        h(
          'div',
          {
            'data-dsh-fso-search-slot': '',
            ...(searchExpanded ? { 'data-expanded': '' } : {}),
          },
          h(
            'div',
            {
              'data-dsh-fso-search': '',
              ...(searchExpanded ? { 'data-expanded': '' } : {}),
              onClick: () => { setSearchExpanded(true) },
            },
            h(
              P.Tooltip ?? TooltipFallback,
              { label: t('search'), side: 'bottom', delayMs: 500, disabled: searchExpanded, children: h('button', {
                type: 'button',
                'data-dsh-fso-icon-button': '',
                'aria-label': t('search.sessions.aria'),
                'aria-expanded': searchExpanded,
                onClick: event => { event.stopPropagation(); setSearchExpanded(true) },
              }, h(Icons.search, { size: searchExpanded ? 11 : 14 })) },
            ),
            h('input', {
              ref: searchInputRef,
              'data-dsh-fso-search-input': '',
              type: 'text',
              placeholder: t('search.placeholder'),
              maxLength: 500,
              value: query,
              tabIndex: searchExpanded ? 0 : -1,
              onChange: event => { setQuery(event.target.value) },
              onKeyDown: onSearchKeyDown,
            }),
            searchExpanded && h('button', {
              type: 'button',
              'data-dsh-fso-icon-button': '',
              'aria-label': t('search.clear'),
              onClick: event => { event.stopPropagation(); setQuery(''); setSearchExpanded(false) },
            }, h(Icons.close, {})),
          ),
        ),
        h(
          'div',
          {
            'data-dsh-fso-header-actions': '',
            ...(searchExpanded ? { 'data-hidden': '' } : {}),
          },
          h(ViewOptionsMenu, {
            groupBy: view.groupBy,
            orderBy: view.orderBy,
            archivedFilter: view.archivedFilter,
            onGroupPick: groupBy => { patchView({ groupBy }) },
            onOrderPick: orderBy => { patchView({ orderBy }) },
            onArchivedFilterPick: archivedFilter => { patchView({ archivedFilter }) },
            t,
          }),
          typeof pickDirectory === 'function' && h(AddWorkspaceFlow, {
            open: addWorkspaceOpen,
            onClose: () => { setAddWorkspaceOpen(false) },
            workspaces,
            phase: workspaceSnapshot?.phase,
            createWorkspace,
            pickDirectory,
            notify,
            t,
            anchor: h(
              P.Tooltip ?? TooltipFallback,
              { label: t('workspace.add'), side: 'bottom', delayMs: 500, children: h('button', {
                type: 'button',
                'data-dsh-fso-icon-button': '',
                'aria-label': t('workspace.add'),
                onClick: () => { setAddWorkspaceOpen(v => !v) },
              }, h(Icons.projectAdd, { size: 16 })) },
            ),
          }),
        ),
      )

      /** 渲染一个分组的会话行（含折叠配额与「展开其余 / 收起」切换）。
       * 缩进不在这里传：由分组容器的 `--dsh-workspace-indent` 继承。 */
      const renderSessionRows = group => {
        const limit = limits[group.key] ?? COLLAPSED_SESSION_LIMIT
        const visible = collapsedSessionRows(group.sessions, limit)
        // 全部显示时按钮变成「收起」（官方行为）。
        const sessionsExpanded = visible.hiddenCount === 0
        const showOverflow = visible.hiddenCount > 0 || (sessionsExpanded && group.sessions.length > COLLAPSED_SESSION_LIMIT)

        const onOverflowClick = () => {
          setLimits(previous => {
            const current = previous[group.key] ?? COLLAPSED_SESSION_LIMIT
            if (sessionsExpanded) return { ...previous, [group.key]: COLLAPSED_SESSION_LIMIT }
            // 剩余不足一批时直接全展开，避免多一次点击。
            const next = visible.hiddenCount <= COLLAPSED_SESSION_LIMIT ? Infinity : current + COLLAPSED_SESSION_LIMIT
            return { ...previous, [group.key]: next }
          })
        }

        return [
          ...visible.rows.map(row => h(SessionRow, {
            key: row.id,
            node: row,
            currentId,
            now,
            limitKey: group.key,
            onOpen: doOpen,
            onRename: openRenameSession,
            onFork: doFork,
            onPin: sessionId => { doPin(sessionId, pinned.has(sessionId)) },
            onArchive: doArchive,
            onUnarchive: doUnarchive,
            onDragStart: beginSessionDrag,
            onDragOver: hoverSession,
            onDrop: dropSession,
            dropMarker: dropTarget?.kind === 'session' && dropTarget.id === row.id ? dropTarget.marker : undefined,
            dragging: sessionDrag?.sessionId === row.id,
            t,
          })),
          showOverflow && h('button', {
            key: 'overflow',
            type: 'button',
            'data-dsh-fso-overflow': '',
            'aria-expanded': sessionsExpanded,
            onClick: onOverflowClick,
          }, sessionsExpanded
            ? t('sessions.collapse')
            : t('sessions.expand', { n: visible.hiddenCount })),
        ]
      }

      /** 「新建会话」的当前快捷键（按钮提示与 aria-keyshortcuts 都用它）。
       *  必须在 renderGroup 之前声明：ProjectRow 会用到。 */
      const newShortcut = typeof useShortcuts === 'function'
        ? useShortcuts(rows => rows.find(row => row.id === 'session.new'))
        : undefined

      /** 渲染一个分组（含工作区行与其子分组）。 */
      const renderGroup = (group, depth) => {
        const expanded = isExpanded(group.key)
        const childGroups = tree.childrenOf.get(group.key) ?? []
        // 后代含当前会话时，祖先文件夹也高亮（官方行为）。
        const active = groupContainsCurrent(group)
          || (expanded && childGroups.some(child => groupContainsCurrent(child)))
        return h(
          'div',
          {
            key: group.key === '' ? '__ungrouped__' : group.key,
            'data-dsh-fso-group': '',
            // 官方在 groupSection 上写 --dsh-workspace-indent，行与「展开其余」
            // 按钮都从它继承缩进。
            style: { '--dsh-workspace-indent': `${(depth ?? 0) * 12}px` },
          },
          h(ProjectRow, {
            group,
            expanded,
            active,
            newShortcut,
            home: hostHome,
            onToggle: (key, next) => {
              patchView({ expandedGroups: { ...view.expandedGroups, [key]: next } })
            },
            onNewSession: workspaceId => { startSession(workspaceId) },
            onRename: openRenameWorkspace,
            onDelete: openDeleteWorkspace,
            onDragStart: beginWorkspaceDrag,
            onDragOver: hoverWorkspace,
            onDrop: dropWorkspace,
            dropMarker: dropTarget?.kind === 'workspace' && dropTarget.id === group.workspaceId ? dropTarget.marker : undefined,
            dragging: workspaceDrag?.workspaceId === group.workspaceId && group.workspaceId !== undefined,
            t,
          }),
          expanded && h(
            'div',
            { 'data-dsh-fso-group-sessions': '', role: 'group' },
            // 官方顺序：子工作区显示在父级**自己的会话之前**。
            ...childGroups.map(child => renderGroup(child, (depth ?? 0) + 1)),
            ...renderSessionRows(group),
          ),
        )
      }

      const searchActive = query.trim() !== ''
      const archivedOnly = view.archivedFilter === 'only'
      const totalRows = groups.reduce((sum, group) => sum + group.sessions.length, 0)

      let body
      if (searchActive) {
        if (searchRows.length > 0) {
          body = searchRows.map(row => {
            const statuses = sessionStatuses(row, t)
            const primaryStatus = statuses[0]
            const selected = row.id === currentId
            return h('div', {
              key: row.id,
              'data-dsh-fso-result': '',
              ...(selected ? { 'data-selected': '' } : {}),
              ...(row.archived ? { 'data-archived': '' } : {}),
              // 官方用 treeitem（不是 button）：行内含「取消归档」按钮，嵌套 button 非法。
              role: 'treeitem',
              'aria-selected': selected,
              'aria-description': row.archived ? t('toast.archivedNotOpenable') : undefined,
              onClick: () => { doOpenResult(row) },
            },
              h('span', { 'data-dsh-fso-result-heading': '' },
                h('span', { 'data-dsh-fso-slot': '' },
                  row.archived !== true && primaryStatus.state !== 'idle'
                    ? h(SessionStatusDots, { statuses })
                    : null,
                ),
                h('span', { 'data-dsh-fso-result-title': '' }, rowDisplayTitle(row, t)),
                // 归档结果行提供「取消归档」（官方行为）。
                row.archived === true && h('span', { 'data-dsh-fso-row-actions': '' },
                  h(P.Tooltip ?? TooltipFallback, {
                    label: t('actions.unarchive'),
                    side: 'bottom',
                    align: 'end',
                    delayMs: 500,
                    children: h('button', {
                      type: 'button',
                      'data-dsh-fso-icon-button': '',
                      'aria-label': t('menu.unarchiveSession'),
                      onClick: event => { event.stopPropagation(); doUnarchive(row.id) },
                    }, h(Icons.unarchive, { size: 14 })),
                  }),
                ),
              ),
              h('span', { 'data-dsh-fso-result-meta': '' },
                h('span', { 'data-dsh-fso-result-workspace': '' }, row.workspace),
                row.snippet !== undefined && h('span', { 'data-dsh-fso-result-snippet': '' }, row.snippet),
              ),
            )
          })
          if (searchHasMore) {
            body = [...body, h('div', { key: 'more', 'data-dsh-fso-result-status': '' }, t('search.hasMore', { n: Number(searchResultLimit) || 20 }))]
          }
        } else if (remoteResults.loading) {
          // 官方：加载时显示骨架屏（无结果 2 行，有结果 1 行）。
          body = [0, 1].map(index => h('div', { key: `skeleton-${String(index)}`, 'data-dsh-fso-skeleton': '', role: 'status', 'aria-label': t('search.pending') },
            h('span', { 'data-dsh-fso-skeleton-dot': '' }),
            h('span', { 'data-dsh-fso-skeleton-bars': '' },
              h('span', { 'data-dsh-fso-skeleton-bar': '' }),
              h('span', { 'data-dsh-fso-skeleton-bar': '', 'data-wide': '' }),
            ),
          ))
        } else {
          body = h('div', { 'data-dsh-fso-result-status': '' }, t('search.noMatches'))
        }
      } else if (totalRows === 0) {
        body = h(EmptyState, {
          archivedOnly,
          onShowOthers: () => { patchView({ archivedFilter: 'default' }) },
          t,
        })
      } else if (view.groupBy === 'flat') {
        // 单列表：成员来自全部可见会话，而不是把分组结果拼起来。
        body = h('div', { 'data-dsh-fso-flat-list': '' }, ...renderSessionRows(flat))
      } else {
        body = tree.roots.map(group => renderGroup(group, 0))
      }

      /* 官方「新会话」按钮由 ui-sidebar 渲染，位于 logoRow 之后、工作区之前：
       *   · Tooltip 包裹，宽态下 tooltip 禁用（按钮自带文案）；
       *   · 图标在宽态用 IconNewChatOutlineMedium(14)；
       *   · 右侧有快捷键提示（ShortcutKeys），aria-keyshortcuts 同步暴露。 */
      const ShortcutKeys = P.ShortcutKeys
      const newSessionButton = merged.showNewSession === true
        ? h(
            P.Tooltip ?? TooltipFallback,
            {
              label: t('session.new.label'),
              shortcutKeys: newShortcut?.keys,
              delayMs: 500,
              side: 'bottom',
              disabled: true,
              children: h('button', {
                type: 'button',
                'data-dsh-fso-new': '',
                'aria-label': t('session.new.label'),
                'aria-keyshortcuts': newShortcut?.aria,
                onClick: () => { startSession() },
              },
                h(P.IconNewChatOutlineMedium ?? Icons.newChat, { size: 14 }),
                h('span', null, t('session.new')),
                ShortcutKeys !== undefined && newShortcut?.keys?.length > 0
                  && h('span', { 'data-dsh-fso-new-shortcut': '', 'aria-hidden': 'true' },
                    h(ShortcutKeys, { keys: newShortcut.keys })),
              ),
            },
          )
        : null

      /* 顶部一行：个人信息按钮 + 新会话。
       * 官方把账户入口放在侧边栏底部；浮层状态下那一段不可见，所以挪到
       * 顶部、紧挨「新会话」左边。两者任何一个被关掉时，这一行仍成立
       * （只剩另一个），所以始终渲染 topbar 容器。
       *
       * 个人信息按钮点下去**直接打开官方设置弹窗**（不弹账户菜单）。
       * 只要拿到账户数据源或打开设置的函数其一就渲染 —— 头像可降级为
       * 默认图标，但按钮至少得能打开设置才不是假按钮。 */
      const profileButton = merged.showProfile === true && (accountSource !== undefined || typeof openSettings === 'function')
        ? h(ProfileButton, {
            key: 'profile',
            accountSource,
            // 账户文案走官方 `settings.account` 命名空间。
            t: typeof accountT === 'function' ? accountT : t,
            onOpenSettings: typeof openSettings === 'function' ? openSettings : () => {},
          })
        : null
      const topbar = h('div', { 'data-dsh-fso-topbar': '' }, profileButton, newSessionButton)

      /* ── 模态框 ───────────────────────────────────────────────────────── */
      const Modal = P.Modal
      const Button = P.Button
      const modals = []

      if (renameTarget !== null && Modal !== undefined) {
        modals.push(h(Modal, {
          key: 'rename',
          open: true,
          onClose: closeRename,
          closeLabel: t('close'),
          title: renameTarget.kind === 'workspace' ? t('rename.workspace.title') : t('rename.session.title'),
          footer: h(react.Fragment, null,
            h(Button ?? 'button', { variant: 'outline', disabled: renameBusy, onClick: closeRename }, t('cancel')),
            h(Button ?? 'button', {
              variant: 'primary',
              disabled: renameBlocked,
              onClick: confirmRename,
            }, t('rename')),
          ),
          children: [
            h('input', {
              key: 'input',
              'data-dsh-fso-rename-input': '',
              type: 'text',
              value: renameDraft,
              'aria-label': renameTarget.kind === 'workspace' ? t('field.workspaceName') : t('field.sessionName'),
              'data-modal-autofocus': true,
              disabled: renameBusy,
              // 官方：聚焦时全选，便于直接覆写。
              onFocus: event => { event.target.select() },
              onChange: event => { setRenameDraft(event.target.value); setRenameError(null) },
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                confirmRename()
              },
            }),
            // 重名提示是**实时**的（渲染期派生），不是提交后才出现。
            renameDuplicate && h('div', {
              key: 'duplicate',
              'data-dsh-fso-modal-error': '',
              role: 'alert',
            }, t('conflict.named', { name: renameTrimmed })),
            renameError !== null && h('div', { key: 'error', 'data-dsh-fso-modal-error': '', role: 'alert' }, renameError),
          ],
        }))
      }

      if (deleteTarget !== null && Modal !== undefined) {
        modals.push(h(Modal, {
          key: 'delete',
          open: true,
          onClose: closeDelete,
          closeLabel: t('close'),
          title: t('delete.workspace'),
          description: t('delete.desc', { name: deleteTarget.label }),
          footer: h(react.Fragment, null,
            h(Button ?? 'button', { variant: 'outline', disabled: deleteBusy, onClick: closeDelete }, t('cancel')),
            h(Button ?? 'button', {
              variant: 'outline',
              'data-dsh-fso-delete-action': '',
              disabled: deleteBusy,
              onClick: confirmDelete,
            }, t('delete.action')),
          ),
          children: [
            deleteBusy && h('div', { key: 'busy', 'data-dsh-fso-modal-status': '', role: 'status' }, t('delete.pending')),
            deleteError !== null && h('div', { key: 'error', 'data-dsh-fso-modal-error': '', role: 'alert' }, deleteError),
          ],
        }))
      }

      if (archiveConfirm !== null && Modal !== undefined) {
        modals.push(h(Modal, {
          key: 'archive',
          open: true,
          onClose: () => { if (!archiveBusy) setArchiveConfirm(null) },
          closeLabel: t('close'),
          title: t('archive.confirm.title'),
          description: t('archive.confirm.desc', { title: archiveConfirm.title }),
          footer: h(react.Fragment, null,
            h(Button ?? 'button', {
              variant: 'outline',
              disabled: archiveBusy,
              onClick: () => { if (!archiveBusy) setArchiveConfirm(null) },
            }, t('cancel')),
            h(Button ?? 'button', { variant: 'outline', disabled: archiveBusy, onClick: confirmStopAndArchive }, t('archive.confirm.action')),
          ),
          children: [
            h('ul', { key: 'activity', 'data-dsh-fso-activity': '', 'aria-label': t('archive.confirm.activity') },
              archiveConfirm.activity.map((entry, index) => h('li', { key: `${entry.kind}-${String(index)}` }, activityLine(entry, t))),
            ),
            archiveBusy && h('div', { key: 'busy', 'data-dsh-fso-modal-status': '', role: 'status' }, t('archive.confirm.pending')),
            archiveError !== null && h('div', { key: 'error', 'data-dsh-fso-modal-error': '', role: 'alert' }, archiveError),
          ],
        }))
      }

      return h(
        'div',
        { 'data-dsh-fso-panel': '' },
        h(
          'div',
          {
            'data-dsh-fso-card': '',
            role: 'navigation',
            'aria-label': t('section.workspaces'),
          },
          topbar,
          header,
          // 结构对齐官方：listArea → treeBody（承载 fade 遮罩）→ 滚动容器。
          h(
            'div',
            { 'data-dsh-fso-list-area': '' },
            h(
              'div',
              { 'data-dsh-fso-tree-body': '' },
              h(
                'div',
                {
                  'data-dsh-fso-list-scroll': '',
                  role: 'tree',
                  'aria-label': searchActive ? t('search.results.aria') : sectionLabel,
                },
                body,
              ),
              h('span', { 'data-dsh-fso-fade': '' }),
            ),
          ),
        ),
        ...modals,
      )
    }

    /** 归档确认框里一行活动描述（复刻官方 `activityLine`）。 */
    function activityLine(entry, t) {
      const items = Array.isArray(entry?.items) ? entry.items : []
      const n = items.length
      const names = items.map(item => item?.label ?? item?.id ?? '').join(t('archive.confirm.listSeparator'))
      const plural = n === 1 ? 'one' : 'other'
      switch (entry?.kind) {
        case 'turn': return t('archive.confirm.turn')
        case 'subagent': return t(`archive.confirm.subagents.${plural}`, { n, names })
        case 'job': return t(`archive.confirm.jobs.${plural}`, { n, names })
        case 'schedule': return t(`archive.confirm.schedules.${plural}`, { n, names })
        default: return t(`archive.confirm.other.${plural}`, { kind: entry?.kind ?? '', n })
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 插件主体
     * ══════════════════════════════════════════════════════════════════════ */

    function apply(ctx, config) {
      const merged = { ...DEFAULTS, ...(config ?? {}) }
      const css = buildCss(merged)
      const animMs = Math.max(0, Number(merged.animationMs) || 0)

      /** 指针状态。 */
      let open = false
      let enabled = merged.enabled !== false
      let disposed = false

      /** 取卡片节点（可能还没渲染出来）。 */
      const cardOf = () => document.querySelector('[data-dsh-fso-card]')

      /**
       * 写开关状态。
       *
       * 状态写在**卡片自身的属性**上，而不是 <html> 上：
       * 写在 <html> 上会让浏览器在每次开合时重算整个文档的样式匹配，
       * 这正是旧方案「打开时闪一下」的成因之一。
       */
      const setOpen = next => {
        if (disposed) return
        if (next === open) return
        open = next
        const card = cardOf()
        if (card !== null) {
          if (open) card.setAttribute(ATTR_CARD_OPEN, '')
          else card.removeAttribute(ATTR_CARD_OPEN)
        }
        if (merged.debug === true) console.info('[sidebar-overlay] open =', open)
      }

      /* ── 语言字典 ───────────────────────────────────────────────────────
       * 用 `ctx.inject` 而不是「apply 时 ctx.get 一次」：`locale` 可能晚于本插件
       * 就绪（客户端插件按名册并发激活）。`ctx.inject` 会等依赖可用才执行回调，
       * 并在依赖重建时重新执行，所以字典不会静默丢失。 */
      ctx.inject(['locale'], localeCtx => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { zh: ZH, en: EN }),
          'sidebar-overlay: dictionaries')
      })

      /* ── 样式注入 ─────────────────────────────────────────────────────── */
      ctx.effect(() => {
        if (css.trim() === '') return () => {}
        const style = document.createElement('style')
        style.id = 'dsh-sidebar-overlay-style'
        style.textContent = css
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'sidebar-overlay: styles')

      /* ── 标题栏高度：写入 CSS 变量 ────────────────────────────────────────
       * 卡片必须从标题栏下方开始，否则会盖住窗口按钮。
       * 不能读 `--dsh-windows-titlebar-height`（它没有静态定义，只由桌面端
       * preload 注入）；改用官方 layout 确实会派生的 `--dsh-frame-top-clearance`，
       * 并按平台兜底。 */
      ctx.effect(() => {
        const html = document.documentElement
        const applyTop = () => {
          const isWindows = html.hasAttribute('data-windows-titlebar')
          const isDarwin = html.getAttribute('data-platform') === 'darwin'
          const fallback = isWindows ? 40 : (isDarwin ? 48 : 0)
          const raw = getComputedStyle(html).getPropertyValue('--dsh-frame-top-clearance').trim()
          const parsed = parseFloat(raw)
          const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
          html.style.setProperty('--dsh-fso-top', `${value}px`)
        }
        applyTop()
        const observer = new MutationObserver(applyTop)
        observer.observe(html, { attributes: true, attributeFilter: ['data-windows-titlebar', 'data-platform', 'data-fullscreen'] })
        return () => {
          observer.disconnect()
          html.style.removeProperty('--dsh-fso-top')
        }
      }, 'sidebar-overlay: titlebar clearance')

      /* ── 热区与开关 ───────────────────────────────────────────────────────
       * 与旧插件的关键差异：**不在 pointermove 里查计算样式、也不量布局**。
       * 热区宽度是配置值（默认 24，纯数值）；卡片几何只在「打开那一刻」量一次
       * —— 量的是无 transform 的 panel（布局矩形恒定），所以整个滑入动画期间
       * 都不需要重量 —— 另在 resize 时刷新。 */
      ctx.effect(() => {
        /** 标题栏高度：读 CSS 变量。
         * 读的是**内联** `style` 声明（`--dsh-fso-top` 由上面的 effect 写在内联样式
         * 上），纯字符串取值，不触发样式重算或布局 —— 可以安全地放在热路径里。
         * （与之相对，`getComputedStyle` / `getBoundingClientRect` 会强制同步结算，
         * 那才是旧插件每次 pointermove 都卡的原因。） */
        const readTitlebar = () => {
          const parsed = parseFloat(document.documentElement.style.getPropertyValue('--dsh-fso-top'))
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        }

        const triggerConfig = merged.trigger
        /** 热区占「对话内容列左边缘」的比例；夹到 (0, 1]，非法值回落默认值。 */
        const rawRatio = Number(merged.triggerRatio)
        const triggerRatio = Number.isFinite(rawRatio) && rawRatio > 0
          ? Math.min(rawRatio, 1)
          : DEFAULT_TRIGGER_RATIO
        const slack = Math.max(0, Number(merged.closeSlack) || 0)
        const gap = Math.max(0, Number(merged.gap) || 0)

        /* 折叠态判定：官方 frame 上的 `data-sidebar-collapsed`。
         *
         * **缓存元素引用**，避免每次 pointermove 都跑一次属性选择器查询。
         * 原先这里每次事件都 `querySelector('[class$="_frame"][data-sidebar-collapsed]')`
         * —— 虽然比 `getComputedStyle` 便宜，但热区扩大后指针停留在区域内的时间
         * 显著变长（事件更密），把一个 DOM 查询留在热路径上不再合理。
         *
         * 缓存失效的判据是 `isConnected === false`（官方重挂 AppFrame 时旧节点
         * 会脱离文档）；此时重新查询。`isConnected` 在极老的实现里可能缺失，
         * 缺失（undefined）时按「仍然有效」处理，退回原来的每帧查询也只是慢，
         * 不会错。 */
        let frameEl = null
        const isCollapsed = () => {
          if (frameEl === null || frameEl.isConnected === false) {
            frameEl = document.querySelector('[class$="_frame"]')
          }
          return frameEl !== null && frameEl.hasAttribute('data-sidebar-collapsed')
        }

        /* ── 热区几何（右边界 + 上边界）─────────────────────────────────────
         * 热区是一个矩形：
         *   x ∈ [0, rightEdge]      rightEdge 见下
         *   y ∈ [topEdge, ∞)        topEdge 排除窗口标题栏与对话区 header
         *
         * 三种模式：
         *   数值         固定像素宽度；
         *   'auto'       官方侧边栏列宽（保底 56）；
         *   'content'    对话内容列左边缘 × triggerRatio（默认）。
         *
         * 'content' 的语义就是用户要的「对话区域左侧、从左边缘起从左往右
         * 40%」：折叠态下对话内容列是**居中**的（官方
         * `.column{max-width:var(--dsh-chat-content-width);width:100%;margin:0 auto}`），
         * 所以「窗口左边缘 → 内容列左边缘」是一段留白，取它的 40% 作为热区宽度。
         *
         * 上边界同样取自对话内容容器的顶边 —— 那是对话区 header 的底边，
         * 于是「对话/轨迹 tab、会话标题」那一条**整块**都被排除在热区之外。
         *
         * ⚠ 这段会 `getBoundingClientRect` + `getComputedStyle`，**绝不可放进
         * pointermove 热路径**（旧插件正是每次都查才卡）。所以只在初始、resize、
         * 开合瞬间，以及指针在热区外时的低频兜底里算，热路径只读缓存。 */
        let triggerPx = null
        let triggerTop = null

        /** 对话区尚未挂载时的兜底：用官方的宽度公式按视口推算，不读 DOM。
         * 折叠态下中栏几乎等于视口宽（侧边栏列宽为 0），所以这个近似足够准，
         * 且会被随后的「打开那一刻 / resize / 低频重测」覆盖。
         * 上边界无 DOM 可依时只能退回窗口标题栏。 */
        const triggerFallback = () => fallbackTriggerEdge(Number(window.innerWidth) || 0, triggerRatio)

        /* 取**主对话区**的 `[data-conversation-content]`。
         *
         * 这个属性不止一处：官方 `ui-subagent` 的「子智能体对话」在右侧栏里
         * 通过 `sidebar.chat.conversation` → `conversation.content`（变体
         * `embedded`）渲染**同一个组件**，也会带上这个属性。右侧栏那个实例
         * 位于窗口右侧、容器窄得多，用它算出来的「内容列左边缘」会大出一个
         * 量级，热区会直接盖住半个窗口。
         *
         * 所以显式排除右侧栏内的实例（官方在右侧栏容器上标了
         * `data-sidebar-right-session`）。这是冷路径，多一次 closest 无所谓。 */
        const mainConversation = () => {
          let all = []
          try {
            all = typeof document.querySelectorAll === 'function'
              ? document.querySelectorAll('[data-conversation-content]')
              : []
          } catch { all = [] }

          /* 查到节点：取第一个不在右侧栏里的。若全都属于右侧栏（主对话区还没
           * 挂载），返回 null 让调用方走视口兜底 —— **不能**退而使用右侧栏那个
           * 实例，它的几何会算出大得离谱的热区。 */
          if (all.length > 0) {
            for (const el of all) {
              if (typeof el.closest === 'function' && el.closest('[data-sidebar-right-session]') !== null) continue
              return el
            }
            return null
          }

          /* 一个都没查到：可能是 `querySelectorAll` 不可用（测试桩），退回单元素
           * 查询。此时无法判断归属，但主对话区在前的概率很高。 */
          return document.querySelector('[data-conversation-content]')
        }

        /**
         * 测量热区几何（冷路径）。
         * @returns {{right: number, top: number}} 右边界与上边界。
         */
        const measureTrigger = () => {
          const titlebar = readTitlebar()

          // 显式数值：固定宽度。上边界仍取「标题栏」—— 没有对话区几何可依。
          if (triggerConfig !== 'auto' && triggerConfig !== 'content') {
            const n = Number(triggerConfig)
            return { right: Number.isFinite(n) && n > 0 ? n : 24, top: titlebar }
          }

          // 'auto'：官方侧边栏列宽，保底 56。上边界尽量取对话区顶边。
          if (triggerConfig === 'auto') {
            const col = document.querySelector('[class$="_frame"] > [class$="_sidebarCol"]')
            const w = col === null ? 0 : col.getBoundingClientRect().width
            const body = mainConversation()
            const bodyTop = body === null || body === undefined ? 0 : body.getBoundingClientRect().top
            return { right: Math.max(56, w), top: triggerTopEdge(bodyTop, titlebar) }
          }

          // 'content'：对话内容列左边缘 × 比例；上边界 = 对话内容容器顶边。
          const body = mainConversation()
          if (body === null || body === undefined) {
            return { right: triggerFallback(), top: titlebar }
          }
          const rect = body.getBoundingClientRect()
          const style = getComputedStyle(body)
          /** 解析一个 px 值；不可解析时返回 undefined。 */
          const px = name => {
            const raw = style.getPropertyValue(name).trim()
            const n = Number.parseFloat(raw)
            return Number.isFinite(n) && n > 0 ? n : undefined
          }
          /* 注意：**不能**靠 `getComputedStyle` 读 `--dsh-chat-content-width`
           * 来省掉下面的公式。已用 headless Chrome 实测（1020px 视口）：
           *   computed value = "clamp(680px, calc(1020px * .64), 920px)"
           * 即自定义属性只替换 `var()`，**不求值** `clamp()` / `calc()`。
           * `parseFloat` 对它得到 NaN，所以那条"读官方最终值"的路在真实浏览器里
           * 从不生效（测试桩若不模拟这一点就会给出虚假的安全感）。
           *
           * 因此判定顺序是：官方给了**纯数值**就用（用户拖拽宽度时官方写的是
           * `Npx`）；否则按官方公式 `clamp(680, 中栏宽*.64, 920)` 自己算。 */
          const contentWidth = px('--dsh-chat-content-width')
          return {
            right: triggerEdge({
              containerLeft: rect.left,
              containerWidth: rect.width,
              contentWidth,
              userWidth: px('--dsh-chat-user-width'),
            }, triggerRatio),
            top: triggerTopEdge(rect.top, titlebar),
          }
        }

        /** 重新测量并写入缓存。冷路径专用。 */
        const refreshTrigger = () => {
          const measured = measureTrigger()
          triggerPx = measured.right
          triggerTop = measured.top
        }

        /** 热路径：只读缓存；未初始化时算一次（正常不会发生，见下方初始测量）。 */
        const triggerWidth = () => triggerPx ?? (triggerPx = measureTrigger().right)
        /** 热路径：只读缓存的上边界。 */
        const triggerTopEdgeCached = () => triggerTop ?? readTitlebar()

        /* ── 几何：只量「布局矩形」，绝不量视觉矩形 ─────────────────────────
         * 这是本文件最容易踩的坑，也是真机上「鼠标触发时闪烁抽搐」的根因。
         *
         * `card.getBoundingClientRect()` 返回的是**受 transform 影响的视觉矩形**。
         * 卡片在 180ms 里从 `translateX(-110%)` 滑到 `translateX(0)`，所以动画
         * 刚起步时视觉矩形还在屏幕外（right ≈ -20）。此时若用
         *   `clientX > cardRect.right + slack`
         * 判断「指针已离开卡片」，那指针停在热区最左（clientX = 1）也会成立：
         *   1 > (-20) + 8  →  true → 立刻收回
         * 收回后指针仍在热区 → 再次打开 → 又量到屏幕外的矩形 → 又收回……
         * 每帧一轮，视觉上就是高频开合抽搐。实测序列：
         *   开@17ms → 关@233ms → 开@417ms → …（永远到不了稳态）
         *
         * 正确做法：量 **panel**。panel 自身没有 transform，它的矩形就是稳定的
         * 布局矩形；卡片只是 panel 内缩一个 padding(gap)。这样判定与动画相位
         * 完全无关，动画期间怎么飘都不影响。 */
        let geom = null
        const measure = () => {
          const panel = document.querySelector('[data-dsh-fso-panel]')
          if (panel === null) {
            geom = null
            return
          }
          const rect = panel.getBoundingClientRect()
          geom = {
            left: rect.left + gap,
            right: rect.right - gap,
            top: rect.top + gap,
            bottom: rect.bottom - gap,
          }
        }

        /** panel 还没渲染出来时的几何兜底：按配置与视口推算，不读 DOM。 */
        const fallbackGeom = () => ({
          left: gap,
          right: gap + Math.max(120, Number(merged.width) || 280),
          top: readTitlebar(),
          bottom: (Number(window.innerHeight) || 0) - gap,
        })

        /* 首次测量：apply 时对话区可能尚未挂载（客户端插件与官方 UI 并发激活），
         * 所以先算一次，随后由 pointermove 首次触发与 resize 兜住。
         * 若此刻取不到对话区，triggerFallback() 会按视口推出近似值，且
         * 「打开那一刻 / resize / 低频重测」都会覆盖它 —— 不会永久固化。 */
        refreshTrigger()
        /* 低频重测的时间基准。用 `performance.now()`（单调时钟）而不是
         * `Date.now()`：后者会被系统对时/夏令时回拨，一旦回拨，
         * `now - last < 0` 会让低频重测长期失效（要等时钟重新追上）。
         * `performance` 不可用时退回 `Date.now()`。 */
        const monotonic = () => {
          try {
            const value = globalThis.performance?.now?.()
            return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
          } catch { return Date.now() }
        }
        let lastTriggerMeasure = monotonic()

        const onMove = event => {
          if (disposed || !enabled) return

          // 折叠态才介入（可配置关闭该限制）。
          if (merged.onlyWhenCollapsed === true && !isCollapsed()) {
            if (open) setOpen(false)
            return
          }

          const x = event.clientX
          const y = event.clientY
          /* 上边界 = 窗口标题栏与「对话区 header」中较高的那个。
           * 后者由对话内容容器的顶边给出，所以「对话/轨迹 tab、会话标题」
           * 那一整条 header 都不在热区内。 */
          const belowTop = y >= triggerTopEdgeCached()
          const inTrigger = x <= triggerWidth() && belowTop

          if (!open) {
            /* 未命中时**低频**重测热区：中栏宽度会因用户拖拽、侧边栏开合、
             * 会话切换而变化（官方写入 `--dsh-chat-user-width`），只读 DOM 的
             * 布局也会变（header 有无 tab 时高度不同）。只靠 resize 会漏。
             * 代价极低 —— 指针不在热区时用户并未交互，且 500ms 最多一次。 */
            if (!inTrigger) {
              const now = monotonic()
              if (now - lastTriggerMeasure >= 500 || now < lastTriggerMeasure) {
                lastTriggerMeasure = now
                refreshTrigger()
              }
              return
            }

            /* 命中后**复核**：先用缓存值命中，再重测一次确认。
             * 缓存值偏大（比如中栏刚变窄、内容列左移）时，指针其实已在热区
             * 之外；若不复核就会「打开 → 下一次事件立刻收起」，边界上抖一下。
             * 只在这里重测，因为这是冷路径（真正要打开的那一次）。 */
            lastTriggerMeasure = monotonic()
            refreshTrigger()
            if (x <= triggerPx && y >= triggerTop) {
              // 打开那一刻量一次布局矩形。panel 没有 transform，所以这次测量
              // 与随后的滑入动画无关，整个动画期间都不用再量。
              measure()
              setOpen(true)
            }
            return
          }

          /* 已打开：用**布局矩形**（恒定，与动画相位无关）判断指针是否离开。
           *
           * 第二处修正：热区必须算作「打开区域内」。
           * 卡片只占左侧一小块（gap=8 起、宽 width），热区则是
           * [0, trigger] 且 trigger 通常远大于卡片右缘。指针停在
           * 卡片右缘之外、热区之内时，若只看卡片就会收起；
           * 收起后指针仍在热区 → 再次打开 → 再次收起 …… 又是振荡。
           * 所以「离开」的判据是：既不在卡片里，也不在热区里。 */
          const box = geom ?? fallbackGeom()
          const outsideCard = x < box.left - slack || x > box.right + slack
            || y < box.top - slack || y > box.bottom + slack
          if (outsideCard && !inTrigger) setOpen(false)
        }

        const onLeave = () => { if (open) setOpen(false) }

        /* 视口变化会让缓存的布局矩形与热区几何同时失效；
         * 只在 resize 时重量，不进热路径。 */
        const onResize = () => {
          refreshTrigger()
          if (open) measure()
        }

        document.addEventListener('pointermove', onMove, { passive: true })
        document.addEventListener('pointerleave', onLeave, { passive: true })
        window.addEventListener('resize', onResize, { passive: true })

        return () => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerleave', onLeave)
          window.removeEventListener('resize', onResize)
        }
      }, 'sidebar-overlay: hover reveal')

      /* ── 浮层注册 ───────────────────────────────────────────────────────
       * `shell.overlay` 是官方 `list` slot，用 id 区分条目，可自由新增。
       * 不声明 children —— 本插件自建 DOM，不渲染任何子 slot。
       *
       * 只有 `slots` 是硬依赖（没有它就没法注册）。其余业务服务在 `inject`
       * 工厂里**按调用时读取**：工厂由渲染器调用，那时服务已就绪，且读到的
       * 总是当前引用 —— 既不阻塞注册，也不会在服务重建后拿着陈旧引用。 */
      ctx.inject(['slots'], slotsCtx => {
        slotsCtx.effect(() => {
          const slots = slotsCtx.slots

          /** 按名取服务；不存在时返回 undefined（调用处自行降级）。 */
          const svc = name => { try { return slotsCtx.get(name) } catch { return undefined } }

          /** 失败提示：一个轻量的自建 toast（不占用官方 slot）。
           * @param key - 字典键；@param params - 插值参数（可选）。 */
          const notify = (key, params) => {
            const text = interpolate(ZH[key] ?? key, params)
            if (merged.debug === true) console.info('[sidebar-overlay] notify:', text)
            try {
              const existing = document.querySelector('[data-dsh-fso-toast]')
              if (existing !== null) existing.remove()
              const node = document.createElement('div')
              node.setAttribute('data-dsh-fso-toast', '')
              node.textContent = text
              node.style.cssText = [
                'position:fixed',
                'left:50%',
                'bottom:48px',
                'transform:translateX(-50%)',
                'z-index:2000',
                'padding:8px 14px',
                'border-radius:var(--dsw-radius-md)',
                // token 名以官方 ui-theme 为准：raised surface 是 `bg-layer-1`。
                'background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))',
                'color:var(--dsw-alias-label-primary)',
                'box-shadow:var(--dsw-elevation-panel)',
                'font-size:13px',
                'pointer-events:none',
              ].join(';')
              document.body.appendChild(node)
              setTimeout(() => { node.remove() }, 3000)
            } catch { /* DOM 不可用：忽略 */ }
          }

          return slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: PANEL_ID,
            locale: NS,
            /** 每次渲染都会调用：此刻读服务，保证拿到当前实例。 */
            inject: () => {
              const uiWorkspace = svc('uiWorkspace')
              const workspacesSvc = svc('workspaces')
              const sessionsSvc = svc('sessions')
              const remote = svc('remote')
              const shortcuts = svc('shortcuts')
              const localeSvc = svc('locale')
              const accountSource = resolveAccountEntry(slots)?.source
              const openSettings = resolveOpenSettings(slots)
              return {
                config: merged,
                /** 官方账户数据源（`settings.launcher` 条目 inject 出来的
                 *  `account` hook）。取不到时传 undefined，头像退化为默认图标。 */
                accountSource,
                /** 账户文案用官方 `settings.account` 命名空间的字典。 */
                accountT: (() => {
                  try {
                    return typeof localeSvc?.bind === 'function' ? localeSvc.bind('settings.account') : undefined
                  } catch { return undefined }
                })(),
                /** 打开官方设置弹窗：走 `sidebar.settings` 条目 store 的
                 *  `actions.open()`（与官方点「设置」同一条路径）。取不到时
                 *  传 undefined，个人信息按钮就不渲染 —— 而不是一个点了没反应的假按钮。 */
                openSettings,
                /** 快捷键目录：渲染器按 hooks 约定自动生成 useShortcuts prop。
                 *  source 缺失时组件内的类型检查会兜住。 */
                ...(shortcuts?.catalog === undefined ? {} : { hooks: { shortcuts: shortcuts.catalog } }),
                /** 打开会话。 */
                openSession: id => {
                  try { uiWorkspace?.openSession?.(id) } catch (error) {
                    console.warn('[sidebar-overlay] openSession 失败:', error?.message ?? error)
                  }
                },
                /** 新建会话（可指定工作区）。 */
                startSession: workspaceId => {
                  try { uiWorkspace?.startSession?.(workspaceId) } catch (error) {
                    console.warn('[sidebar-overlay] startSession 失败:', error?.message ?? error)
                  }
                },
                /** 分叉会话。 */
                forkSession: sessionId => {
                  if (typeof uiWorkspace?.forkSession !== 'function') return Promise.reject(new Error('fork unavailable'))
                  return uiWorkspace.forkSession(sessionId)
                },
                /** 重命名会话（需要临时 retain 到 `workspaceOperation`）。 */
                renameSession: (sessionId, title) => {
                  if (typeof sessionsSvc?.using !== 'function') return Promise.reject(new Error('sessions service unavailable'))
                  return Promise.resolve(sessionsSvc.using(sessionId, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(title)))
                    .then(result => {
                      if (result?.ok === false) throw new Error(result.error?.message ?? 'rename failed')
                    })
                },
                pinSession: sessionId => Promise.resolve(uiWorkspace?.pinSession?.(sessionId)),
                unpinSession: sessionId => Promise.resolve(uiWorkspace?.unpinSession?.(sessionId)),
                archiveSession: (sessionId, options) => Promise.resolve(uiWorkspace?.archiveSession?.(sessionId, options)),
                unarchiveSession: sessionId => Promise.resolve(uiWorkspace?.unarchiveSession?.(sessionId)),
                renameWorkspace: (workspaceId, title) => Promise.resolve(workspacesSvc?.rename?.(workspaceId, title)),
                deleteWorkspace: workspaceId => Promise.resolve(workspacesSvc?.delete?.(workspaceId)),
                insertWorkspaceBefore: (workspaceId, beforeWorkspaceId) => Promise.resolve(workspacesSvc?.insertBefore?.(workspaceId, beforeWorkspaceId)),
                createWorkspace: input => Promise.resolve(workspacesSvc?.create?.(input)),
                /** 内容搜索：解包 RemoteResult。 */
                searchSessions: (query, signal) => {
                  if (typeof sessionsSvc?.search !== 'function') return Promise.resolve({ items: [], hasMore: false })
                  return Promise.resolve(sessionsSvc.search(query, signal)).then(result => {
                    if (result?.ok === false) throw new Error(result.error?.message ?? 'search failed')
                    return result?.value ?? { items: [], hasMore: false }
                  })
                },
                searchResultLimit: Number(sessionsSvc?.searchResultLimit) || 20,
                /** 目录选择：优先走官方 uiWorkspace，缺失时退到 remote.directoryPicker。 */
                pickDirectory: () => {
                  if (typeof uiWorkspace?.pickDirectory === 'function') return uiWorkspace.pickDirectory()
                  if (typeof remote?.directoryPicker?.pick === 'function') {
                    return Promise.resolve(remote.directoryPicker.pick()).then(result => (result?.ok === false ? null : (result?.value ?? null)))
                  }
                  return Promise.resolve(null)
                },
                /** Host 家目录（用于路径缩写）。 */
                hostHome: remote?.$host?.home,
                notify,
              }
            },
          }, FloatingSidebar), 'sidebar-overlay: overlay panel')
        }, 'sidebar-overlay: overlay registration')
      })

      /* ── 总开关 API ─────────────────────────────────────────────────────── */
      ctx.effect(() => {
        const api = {
          enable: () => {
            enabled = true
            document.documentElement.removeAttribute(ATTR_OFF)
          },
          disable: () => {
            enabled = false
            setOpen(false)
            document.documentElement.setAttribute(ATTR_OFF, OFF)
          },
          toggle: () => { enabled ? api.disable() : api.enable(); return enabled },
          isEnabled: () => enabled,
          isOpen: () => open,
        }
        window.__dshFloatingSidebarOverlay = api

        if (merged.enabled === false) api.disable()

        return () => {
          disposed = true
          setOpen(false)
          document.documentElement.removeAttribute(ATTR_OFF)
          if (window.__dshFloatingSidebarOverlay === api) delete window.__dshFloatingSidebarOverlay
        }
      }, 'sidebar-overlay: toggle api')

      /* ── 快捷键（软依赖）────────────────────────────────────────────────
       * 同样用 `ctx.inject` 等 `shortcuts` 就绪；缺失时整块不执行，插件其余
       * 功能不受影响。 */
      if (merged.hotkey === true) {
        ctx.inject(['shortcuts'], shortcutCtx => {
          const binding = merged.hotkeyBinding ?? DEFAULTS.hotkeyBinding
          const defaults = {}
          for (const platform of ['windows', 'macos', 'linux']) defaults[`desktop:${platform}`] = binding
          for (const platform of ['windows', 'macos']) defaults[`web:${platform}`] = binding

          shortcutCtx.effect(() => {
            try {
              return shortcutCtx.shortcuts.register({
                id: 'sidebar-overlay.toggle',
                label: () => '切换独立浮动侧边栏',
                aliases: ['floating sidebar overlay', '独立浮动侧边栏'],
                defaults,
                regions: ['page', 'editable', 'terminal'],
                modals: [],
                resolve: () => ({
                  status: 'handled',
                  run: () => { window.__dshFloatingSidebarOverlay?.toggle() },
                }),
              })
            } catch (error) {
              console.warn('[sidebar-overlay] 快捷键注册失败:', error?.message ?? error)
              return () => {}
            }
          }, 'sidebar-overlay: toggle shortcut')
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'sidebar-overlay'
    // 便于测试脚本直接校验纯函数、生成的 CSS 与组件渲染。
    exports.__buildCss = buildCss
    exports.__FloatingSidebar = FloatingSidebar
    exports.__DEFAULTS = DEFAULTS
    // 热区几何：右边界 = 对话内容列左边缘 × triggerRatio；上边界排除 header。
    exports.__triggerEdge = triggerEdge
    exports.__contentColumnWidth = contentColumnWidth
    exports.__fallbackTriggerEdge = fallbackTriggerEdge
    exports.__triggerTopEdge = triggerTopEdge
    exports.__relativeTimeBucket = relativeTimeBucket
    exports.__rowDisplayTitle = rowDisplayTitle
    exports.__workspaceDisplayTitle = workspaceDisplayTitle
    exports.__workspaceTitleOf = workspaceTitleOf
    exports.__abbreviateHomePath = abbreviateHomePath
    exports.__sessionVisible = sessionVisible
    exports.__mainSessionId = mainSessionId
    exports.__orderByRecency = orderByRecency
    exports.__reconcileManualOrder = reconcileManualOrder
    exports.__pinCurrentBlank = pinCurrentBlank
    exports.__sectionMembers = sectionMembers
    exports.__sessionStatuses = sessionStatuses
    exports.__runningChildCount = runningChildCount
    exports.__sessionNode = sessionNode
    exports.__owningParentFolder = owningParentFolder
    exports.__collapsedSessionRows = collapsedSessionRows
    exports.__buildFlat = buildFlat
    exports.__buildGroups = buildGroups
    exports.__nestGroups = nestGroups
    exports.__localSearch = localSearch
    exports.__readViewState = readViewState
    exports.__interpolate = interpolate
    exports.__resolveAccountEntry = resolveAccountEntry
    exports.__resolveOpenSettings = resolveOpenSettings
    exports.__bindEntryFace = bindEntryFace
    exports.__ProfileButton = ProfileButton
    return module.exports
  },
})
