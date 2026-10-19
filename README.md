# dsh-sidebar-overlay — 独立渲染的浮动侧边栏

侧边栏**折叠时**，鼠标移到窗口左侧会浮出一张完整的侧边栏卡片（工作区 + 会话
浏览，覆盖在内容之上，**不挤压中栏**）；鼠标离开即收回。

热区是**「窗口左边缘 → 对话内容列左边缘」这段留白的 40%**（可配置）。1020px
宽的窗口下对话内容列居中出现（宽 680、左边缘 170），热区即 `0..68` ——
而不是一条贴边的窄带。

与旧的 `dsh-floating-sidebar`（CSS 覆盖方案）最本质的区别：

> **它完全不碰官方侧边栏，也不碰官方 grid。** 独立注册进官方 `shell.overlay`
> 浮层座位，自建 DOM 渲染。所以官方侧边栏的折叠/展开态、中栏布局全程零改动。

---

## 为什么要重做

旧方案走的是「复用官方侧边栏 DOM + CSS 浮层化」。那条路能工作，但有两个
**架构决定的、调参消不掉**的代价：

### A. 必须强制改官方 grid → 中栏整体重排

旧插件为了让浮层不挤压中栏，必须覆盖官方 grid：

```css
/* 旧插件 dsh-floating-sidebar/client.js:325-327 */
html[data-dsh-sidebar-hover] [class$="_frame"]:has(> [class$="_sidebarCol"]) {
  grid-template-columns: 0px minmax(0, 1fr) var(--dsh-float-rb, 0px) !important;
}
```

侧边栏列宽从 280px 变 0，**中栏（含全部对话内容）每次开合都要重新布局**。

### B. 动画只能动 `left`，不能用 `transform`

旧插件内部有官方 `position: fixed` 的收起按钮（在标题栏上），给它的祖先加
`transform` 会创建新的包含块、按钮会跳位。所以只能动 `left` —— 而 `left`
**每帧触发 layout**，`transform` 是纯合成。

### 本插件

| | 旧插件 | 本插件 |
|---|---|---|
| 浮层承载 | 改官方列 `position: fixed` + 覆盖 grid | 注册进官方 `shell.overlay` |
| 官方 grid | 每次开合被覆盖 | **从不触碰** |
| 中栏重排 | 有 | **无（已实测：开合全程 grid 只有一种取值）** |
| 动画属性 | `left`（layout） | **`transform`（合成）** |
| 官方类名依赖 | 8 个 `[class$="_xxx"]` 选择器 | **0 个** |
| `!important` | 5 处 | **0 处** |
| 官方侧边栏 DOM | 被改造 | **完全不动** |

---

## 为什么必须自建 UI（已实测确认的硬约束）

这不是偷懒，是 slot 系统的规则决定的：

1. **`sidebar` 与 `sidebar.workspaces` 都是 `single` 座位**，分别被官方
   `ui-sidebar` / `ui-workspace` 占用。slot 系统规定「声明即认领」，
   重复声明同 key 直接抛错（`SlotCore.register`）。
2. **`renderSlot` 的授权绑定在注册者自己的 entry 上**：

   ```js
   // ui-renderer boundRenderSlot
   const declared = entry.children?.[key]
   if (declared === undefined) throw new SlotOwnershipError(...)
   ```

   所以第三方既不能占用官方侧边栏，也不能渲染官方声明的子座位
   （`sidebar.workspaces.session.menu.item` 等）。

结论：**能独立的是「自建 UI」，不是「复制官方 UI」**。本插件注册进
`shell.overlay`（官方 `list` 座位，可自由新增 id），用官方公开的 root hooks
取数据，自建一套等价 UI。

### 官方座位：`shell.overlay`

```js
// ui-layout AppFrame
"shell.overlay": { kind: "list", scope: "root" }
```

它的 CSS 天生为浮层准备：

```css
.BynINW_overlayLayer { z-index:20; pointer-events:none; position:absolute; inset:0 }
.BynINW_overlayLayer > * { pointer-events:auto }
```

### 个人信息按钮：点头像直接打开设置

顶栏左上角那个头像圆钮**点一下直接打开官方设置弹窗**。它不再弹官方账户菜单，
所以没有「联系我们」与「退出登录」两项。

它复用的仍然是官方的东西 —— 但只复用到「数据」这一层：

| 需要什么 | 从哪来 |
|---|---|
| 是否登录 / 昵称 / 头像 URL | `settings.launcher` 条目 `inject()` 里的 `account` observable source |
| 打开设置 | `sidebar.settings` 条目 `store.create().actions.open()` |

官方座位链：

```
sidebar.settings            ← ui-settings-general 声明（single，被它占用）
  └─ settings.launcher      ← ui-settings-account 注册 AccountMenu（single）
```

`renderSlot` 的授权绑定在**声明者 `sidebar.settings` 的条目**上，第三方拿不到；
但条目本身可以用 `ctx.slots.entriesOfSlot(...)` 读到。本插件只取它需要的两样：

```js
// 账户状态：与官方同一份 observable（不会出现两套登录态）
const source = slots.entriesOfSlot('settings.launcher')[0].inject().hooks.account

// 打开设置：官方自己点「设置」走的也是 shellInstance.actions.open()
const handle = slots.entriesOfSlot('sidebar.settings')[0].store
handle.create().actions.open()
```

第二条能成立的关键：ui-settings-general 在注册时把 store 句柄的 `create`
**覆写成了「永远返回同一个实例」**：

```js
const shellInstance = shellHandle.create()
const shellStore = { ...shellHandle, create: () => shellInstance }
```

所以这里 `create()` 拿到的一定是设置弹窗正在读的那一份，`actions.open()`
必然反映到界面上。

> ⚠️ **不能用 `ctx.shortcuts.invoke('settings.open')`** —— 那是本插件踩过的坑。
> `ShortcutsService` 只暴露 `register` / `registerFixed` / `observeFixedInput` /
> `describeBinding`，`invoke` 在内部 `ShortcutRegistry` 上，第三方拿不到。
> 写成 `shortcuts?.invoke?.(...)` 会**静默失败**：不报错、不警告，点了没反应。

头像本身也自己画（38×38 圆钮 + 24×24 头像槽），因为不再渲染官方 `AccountMenu`，
就不该受它 36×36 的尺寸约束。未登录或头像未就绪时降级为内置的人形 SVG ——
不依赖 `ui-primitives`，所以即使 primitives 缺失也不会变成一个空圆壳。

两样都取不到时（官方改了座位名、或相关插件未启用），个人信息按钮**不渲染** ——
而不是渲染一个点了没反应的假按钮。

---

## 数据来源（官方公开契约）

不读官方源码内部、不抓 DOM，只用官方 `provideRoot` 暴露的 root scope hook：

| hook | 来源 | 提供 |
|---|---|---|
| `useSessions` | ui-session | `{ids, byId, phase, projectionsBySession}` |
| `useSessionStatus` | ui-session | `Map<id, {running, pendingInteraction, completionUnread}>` |
| `useWorkspaces` | ui-workspace | `{items, archivedSessionIds, pinnedSessionIds, state, phase}` |
| `usePanelInfo` | ui-layout | `{activePanelId}` |

`provideRoot` 把数据源挂到根作用域，**任何注册到 root 作用域座位的组件都能通过
props 拿到**（`standardHookPropName` 把 `sessions` 变成 `useSessions`）。
`shell.overlay` 正是 `scope: "root"`。

写操作走官方服务：`ctx.uiWorkspace`（openSession / startSession / forkSession /
archiveSession / unarchiveSession / pinSession / unpinSession / pickDirectory）、
`ctx.workspaces`（rename / delete / insertBefore / create）、
`ctx.sessions`（using + rename、search）。

### 会话快照字段（源码逐字确认）

```
{
  id, displayTitle, running, retainedBy: {mainView?: n},
  blank, updatedAt: number, title?, cwd?, parentId?, origin?,
  projectionValues?   // 含 subagentCatalog 等
}
```

`WorkspaceView`：

```
{ workspaceId, path, title, sessionIds, createdAt: string, updatedAt: string }
```

> 注意会话的 `updatedAt` 是 **number**，工作区的 `createdAt`/`updatedAt` 是
> **string**（官方自己用 `Date.parse`），两者不能混用。

---

## 视觉一致性：复用官方组件

官方 `@deepseek-ai/dsh-client-ui-primitives` 是 Web 外壳模块表里的 baseline
external：

```js
// dsh-web-frontend/dist/assets/index-*.js —— 模块表
staticModules: () => ({
  react, "react/jsx-runtime", "react-dom", ...,
  "@deepseek-ai/dsh-client-ui-primitives": sE,
  ...
})
```

所以本插件直接 `require` 官方组件，而不是自己画一套：

`Menu` / `MenuItemButton` / `Modal` / `Tooltip` / `HoverCard` / `StateDot` /
`Button` / `relativeTime`，以及全套图标（`IconSearchOutlineRegular`、
`IconFolderOpenRegular`、`IconEllipsisOutlineRegular`…）。

缺失时逐项降级为内置最简实现（`TooltipFallback` / `StateDotFallback` /
`HoverCardFallback`），不会整块崩掉。

---

## 功能清单

**顶栏：个人信息 + 新会话**
- 顶部一行两枚按钮：**左侧个人信息（头像圆钮）→ 右侧新会话**，同高（38px）居中对齐
- 个人信息按钮：**点一下直接打开官方设置弹窗**，不弹账户菜单，
  所以没有「联系我们 / 退出登录」（详见下方「个人信息按钮」一节）。
  头像与昵称读官方同一份账户数据源，未登录时降级为内置人形图标
- 新会话按钮：38px 高、`.5px` 描边、`button-elevated-fill` 底、字重 500，
  右侧带快捷键提示（`ShortcutKeys`），`aria-keyshortcuts` 同步暴露
- 两者互不影响，可分别用 `showProfile` / `showNewSession` 关掉；
  关掉一个后另一个自动占满整行

**工作区**
- 分组展示（按工作区 / 按工作区树 / 单列表，三态可切并持久化）
- 展开/折叠；祖先文件夹在含当前会话时高亮；后代含当前会话时祖先也高亮
- 新建会话（工作区行 hover 按钮）
- 重命名（「...」菜单，含重名检查与空名校验）
- 删除（确认框，说明文件夹与会话保留、会话落到「未分组」）
- 「未分组」桶不是工作区：**不渲染「...」菜单，也不渲染新建会话按钮**
  （与官方 `ProjectRowItem` 的 `actions: workspaceId === undefined ? undefined`
  一致）。否则菜单会把 `undefined` 当 workspaceId 发给 workspaceController，
  Host 边界校验直接拒绝：
  `workspace delete failed: gateway/input-invalid: typert gateway:
  workspace/delete: wire field "request" failed boundary validation`
- 「未分组」**只在该有可见成员时出现**。可见性判断必须在判断非空之前完成
  （官方 `stray` 就是先 `sessionVisible(...)` 再 `length > 0`）。否则孤儿会话
  全是空白会话或全被归档时，会留下一个 0 行的空分组——点开什么都没有。
  注意 `fullOrder` 仍由**全部** stray 计算，隐藏成员要留在手动排序记账里。
- 拖拽重排（同级；落到后代行时由最近的兼容祖先接收）
- 添加工作区（目录选择 → 登记）
- 悬停卡：完整路径（POSIX 家目录缩写为 `~`）+ 创建时间 + 复制

**会话**
- 行内：状态点（16px 槽）→ 标题 → 相对时间 → 置顶标记 → hover 操作区
- hover 操作区三按钮，顺序与官方原生一致：**「...」菜单 → 归档 → 置顶**
  （置顶排最右，正好落在静止态置顶标记的位置上；hover 时时间与置顶标记自动隐藏）
- 状态优先级：待审批 / 计划待审 / 待回答 > 进行中 > 子智能体运行中 > 已完成 > 空闲
- 相对时间：刚刚 / N分钟 / N小时 / N天 / N个月 / N年
- 当前会话高亮（全局面板活跃时不亮，与官方一致）
- 打开、重命名（双击标题或菜单）、分叉、置顶/取消置顶、归档/取消归档
- 归档时若仍有工作在跑 → 「停止并归档」确认框，按族列出进行中的回合 /
  子智能体 / 后台任务 / 定时提醒，确认后带 `stopActivity` 重试
- 折叠配额：默认每个分组显示 5 条空闲会话，「展开其余 N 个会话」/「收起」
  切换；**空白会话、运行中的会话、有子智能体在跑的父会话不占配额**
- 拖拽排序（写入**完整**记账顺序，含被归档筛选隐藏的成员）
- 悬停卡：完整标题 + 相对时间 + 状态行 + 已归档标记 + 复制
- 归档行置灰、不可拖、点开时提示「取消归档后才能打开」

**搜索**
- 区头搜索框，展开/收起动画（与官方同样的 28px → 30px 尺寸变化）
- 本地即时匹配（标题 + 工作区名，大小写不敏感）
- 远端内容搜索（250ms 防抖，每次新查询 abort 前一个；失败时元数据结果仍显示）
- 结果行：标题 + 工作区名 + 内容片段；显示上限与「仅显示前 N 条」提示
- 空结果占位；Esc 清空并收起

**视图选项菜单**（官方 `Menu`，三组）
- 分组方式：按工作区 / 按工作区树 / 单列表
- 排序方式：手动排序 / 最近更新
- 筛选会话：隐藏已归档 / 全部对话（显示已归档）/ 仅显示已归档

**排序语义**（复刻官方）
- 最近更新：按 `updatedAt` 降序，时间相同按 id 稳定排序
- 手动排序：保存过的相对位置优先；置顶补到最前；新分叉插到来源之前；
  其余按最近更新；归档项垫底
- 分区顺序：空白占位 → 置顶（非归档）→ 其余
- 切到「最近更新」丢弃手动布局；拖拽任意行即切到「手动排序」

---

## 安装

已发布到 npm，在 DSH 的「插件」页点「添加插件」，输入包名
`dsh-sidebar-overlay` 即可；或者用命令行：

```bash
# Web profile
dsh plugin --profile web add dsh-sidebar-overlay

# 其他 profile 把 web 换成对应名字；Desktop 内置 profile 请走图形界面，
# CLI 不允许管理 desktop profile。
```

装完**重启 DSH**（启用 HMR 的 profile 会自动重组，不必重启）。

本地开发时用 `link:` 安装当前目录，改代码后重新构建/重启即可：

```bash
dsh plugin --profile web add link:<本仓库绝对路径>
```

> ⚠️ **与旧的 `dsh-floating-sidebar` 方案互斥**：两者同时启用会得到两个浮动
> 侧边栏。本插件是独立渲染方案，不依赖也不修改旧插件的任何文件。

## 使用

折叠侧边栏（`Ctrl+B` 或点标题栏左侧按钮），把鼠标移到窗口左侧
（**对话区 header 下方**那一段）即可浮出。

热区是一个矩形：

- **上边界**：对话内容容器的顶边 —— 也就是**对话区 header 的底边**。
  「对话 / 轨迹」tab、会话标题、面包屑那一条（官方 `min-height: 76px`）
  以及更上方的窗口标题栏**都不在热区内**，点它们不会浮出侧边栏。
- **右边界**：「窗口左边缘 → 对话内容列左边缘」这段留白的 **40%**
  （向上取整到整像素）：

| 窗口宽 | 内容列宽（官方 `clamp(680, 宽×.64, 920)`） | 内容列左边缘 | 热区右边界（`ceil(左边缘×0.4)`） |
|---|---|---|---|
| 1020 | 680 | 170 | **68** |
| 1440 | 920 | 260 | **104** |
| 1920 | 920 | 500 | **200** |
| 2400 | 920 | 740 | **296** |
| 3000 | 920 | 1040 | **416** |

也就是「对话区域左侧、从左边缘开始、从左往右 40% 都能触发」。指针移出热区
（右侧 60%）或离开窗口才收回。

> 为什么要 `ceil`：按比例算可能得到 `x.999999…`（例如 0.7 时 `170 × 0.7` 在
> IEEE754 下是 `118.99999999999999`），不取整的话整数阈值会落在热区**外**，
> 与文档写的数字差 1px、边界不可预测。取整后「表里写的数字」就是「实际能触发
> 的最后一像素」。0.4 下这些值恰好都是整数，但 `ceil` 仍是在位保险。

> 上边界为什么要读对话内容容器的顶边，而不是写死「标题栏 40 + header 76」：
> 官方 header 的高度**不是常量** —— 有 tab 时 `min-height: 76px`，无 tab 的变体
> （`headerBlank`）是 `min-height: 0; padding-bottom: 0`，darwin 与 Windows 的
> 顶部 clearance 也不同。直接读 body 的实际顶边，头部长什么样都自动适配。

热区几何不是死的：对话内容列宽度会随中栏宽度与用户拖拽变化，对话区 header 的
高度也会随「有没有 tab」变化。本插件在 **冷路径**（初始、`resize`、开合瞬间、
指针在热区外时最多每 500ms 一次）重新测量右边界与上边界，热路径只读缓存。

**总开关**（默认 `Ctrl+Alt+L`）：

```js
window.__dshFloatingSidebarOverlay.toggle()     // 切换
window.__dshFloatingSidebarOverlay.disable()    // 停用（回到官方行为）
window.__dshFloatingSidebarOverlay.enable()
window.__dshFloatingSidebarOverlay.isEnabled()
window.__dshFloatingSidebarOverlay.isOpen()
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖默认值（Desktop 的 profile 是
`~/.dsh/profiles/desktop/cordis.patch.yml`；Web profile 把 `desktop` 换成
`web`）：

```yaml
- id: sidebar-overlay
  name: 'dsh-sidebar-overlay'
  config:
    enabled: true           # 总开关
    width: 280              # 卡片宽度（px），最小 120
    gap: 8                  # 卡片四周留白
    radius: 16              # 卡片圆角
    trigger: 'content'      # 热区模式：'content' 按对话内容列算 | 数值 = 固定 px | 'auto' = 官方列宽
    triggerRatio: 0.4       # trigger='content' 时：占「窗口左边缘→对话内容列左边缘」留白的比例
    closeSlack: 8           # 指针离开多少 px 后收回
    animationMs: 180        # 动画时长（ms）；0 = 瞬时
    fill: 'sidebar'         # 'sidebar' 官方填充 | 'base' 页面底色
    shadow: true            # 官方 elevation 投影
    border: true            # 未投影时的发丝描边
    onlyWhenCollapsed: true # 只在侧边栏折叠时浮出
    groupBy: 'workspace'    # 'workspace' | 'workspace-tree' | 'flat'
    orderBy: 'updated'      # 'updated' | 'manual'
    archivedFilter: 'default' # 'default' | 'show' | 'only'
    showNewSession: true    # 顶部「新会话」按钮
    showProfile: true       # 顶部「个人信息」（官方账户入口）按钮
    hotkey: true
    hotkeyBinding: { code: 'KeyL', modifiers: ['primary', 'alt'] }
    debug: false
```

视图状态（分组方式 / 排序方式 / 筛选 / 展开态 / 手动顺序）存在浏览器
`localStorage` 的 `dsh.floatingSidebarOverlay.view.v1` 下，刷新后保留。

---

## 热路径

旧插件每次 `pointermove` 都调 `getComputedStyle` 和 `getBoundingClientRect`，
两者都会强制同步样式重算 / 布局，鼠标在左边缘移动时每秒触发几十次。

本插件的做法：

- **热区宽度**默认按对话内容列算，但**只在冷路径测量**：初始、`resize`、真正要
  打开的那一刻，以及指针在热区外时最多每 500ms 一次。算出的结果缓存在一个
  数字里，`pointermove` 热路径只比较 `clientX <= triggerPx`；
- **折叠态判定**缓存官方 frame 的元素引用（失效判据 `isConnected === false`），
  避免每次事件都跑一次属性选择器查询；
- **标题栏高度**在 effect 里算一次写进 CSS 变量，热路径只读变量；
- **卡片矩形**在「打开那一刻」与 `resize` 时读 panel 的**布局矩形**
  （不是受 `transform` 影响的视觉矩形，见下节），热路径不读。

实测（`_analysis_tmp/verify-hotpath.mjs` 式的插桩，已开卡后清零计数）：
**已打开 + 在热区内移动 200 次**，`getComputedStyle`、`getBoundingClientRect`、
`querySelector`、`querySelectorAll` 全部为 **0 次**。

> 为什么不能每次事件都量：`getComputedStyle` 会强制同步样式重算、
> `getBoundingClientRect` 会强制布局，鼠标在热区里移动时每秒触发几十次 ——
> 这正是旧插件卡顿的根因。热区扩大后**事件在热区内停留的时间显著变长**，
> 所以这条约束比以前更重要。

---

## 细节对齐（第一轮复查后修正）

初版实现了大致框架，但与官方逐项比对后发现下列差异，均已修正：

| 细节 | 问题 | 现状 |
|---|---|---|
| 卡片内边距 | 漏了官方的 `padding: 6px 12px`，导致区头的负 margin 溢出卡片右侧 | 已对齐；几何测试专门断言「插件节点不越出卡片」 |
| 行内小按钮 | 误用区头的 28×28 规格 | 行内改为官方 16×16、`radius-xs`、tertiary 色、hover 变 primary |
| 行间距 | 相邻行无间距 | 分组内 2px、分组之间 4px（官方的 `* + *` 规则） |
| 拖拽插入线 | 用 2px 内阴影 | 官方是 12px 高、带两个 5×7 小三角 + 2px 横线的渐变 |
| 层级缩进 | 用内联 `paddingLeft` | 改用官方同名变量 `--dsh-workspace-indent`，行与「展开其余」按钮共同继承 |
| 底部渐隐 | 没有 | 补上官方 24px 渐变遮罩（darwin 下隐藏） |
| 悬停卡配色 | 用了主题 token | 官方是硬编码浅色（卡片本身深色底），已照抄 |
| 标题跑马灯 | 完全没有 | 补齐：悬停横滚露出末端，8px 阈值、0.03px/ms、reduced-motion 直跳末端 |
| 重命名 | 提交时才校验、确认按钮用 outline、无重名提示 | 改为渲染期实时派生：未改动/空/重名时禁用确认，按钮 `primary`，重名即时提示 |
| 新会话按钮 | 无快捷键提示、图标用 Regular | 补 `ShortcutKeys` 提示与 `aria-keyshortcuts`，图标改官方 `Medium` |
| 添加工作区 | 直接取目录 | 改为官方流程：Menu（已有工作区 + 「添加工作区…」）→ 目录流 → 失败弹错误框（含「重新选择」） |
| 搜索结果 | 用 `button`（内含按钮造成嵌套非法）、无骨架屏、无取消归档 | 改 `div` + `role="treeitem"`，补官方骨架屏与归档行的「取消归档」按钮 |
| 时间文案 | 行内与悬停卡同一格式 | 行内 `{n}分钟`、悬停卡 `{t}前`；「创建于」改用官方 `date.ymd` 模板而非 `toLocaleString` |
| 空状态 | 12px 字 | 13px，图标 `label-caption` 且下移 4px |
| 列表结构 | 单层滚动容器 | 对齐官方三层：listArea → treeBody（承载 fade）→ 滚动容器 |
| **相邻行间距** | 选择器写成 `list-area > * > * + *`，与单链 DOM 对不上 → **行间距全程为 0**，选中/hover 两块背景粘连 | 按官方三条规则分别落在真正承载行的容器上（group / group-sessions / flat-list / list-scroll） |
| **hover 操作按钮** | 只渲染了「...」菜单，**缺归档与置顶两个行内按钮** | 补齐官方三个按钮及排列（菜单 → 归档 → 置顶）；归档行不渲染置顶（Host 侧互斥）；空白行整块不渲染 |
| hover 时的时间/置顶标记 | 只在菜单打开时隐藏 | 与官方一致：hover **或**菜单打开都隐藏（让位给按钮）；标题同时转 `text-overflow: clip` |
| 搜索结果操作区 | 未靠右 | 补 `margin-left: auto`（官方 `.searchResultHeading .rowActions`） |
| 底部渐隐 | `tree-body`/`list-scroll`/`fade` 渲染了 DOM 但**完全没有 CSS**（渐隐是死的） | 补上三层样式与 24px 渐变；滚动移入最内层，渐隐才能固定在底部 |
| 文案 | 键名与措辞有偏差 | 全部改为官方字典原文（含 `empty.none`、`search.noMatches`、`toast.stoppedAndArchived` 等） |

另修掉两个运行时问题：测试桩里 `useCallback` 被立即执行导致的状态错位（改为返回函数本身），以及单列表拖拽排序静默失效（记账落点与派生来源不一致）。

还修掉两个由「选择器与 DOM 层级脱节」导致的**静默失效**（都不报错、不崩、DOM 也正确，只是样式匹配不上，五套旧测试全部漏过）：

1. **相邻会话行的背景粘连**。间距规则 `[data-dsh-fso-list-area] > * > * + *` 里
   的相邻兄弟选择器要求左侧有兄弟元素，而该处 DOM 是单链，于是规则一个元素
   都匹配不到、行间距恒为 0。两个相邻行同时显示背景（一个选中、一个 hover）
   时粘成一块，与官方侧边栏的 2px 间隔不一致。
2. **指针触发的闪烁抽搐**。判断「指针是否离开」时量的是 `card` 的
   `getBoundingClientRect()`，而卡片正在 `translateX` 动画中，量到的是**视觉
   矩形**（动画初期还在屏幕外）→ 指针停在热区内也被判成「已离开」→ 收起 →
   又在热区 → 再打开，每帧一轮。改为量无 `transform` 的 `panel`（布局矩形），
   并把热区算作「打开区域内」。

两者都补了能真正复现的回归测试：`layout-check.mjs`（选择器 × 真实 DOM）与
`repro-hover-flicker.mjs`（逐帧模拟指针 + 过渡）。**对修复前的代码分别失败
9 项和 7 项**，确保断言不是摆设。

### 热区改为按留白比例（第二轮修改）

原因：原热区是贴左边缘的固定 **24px** 窄带，需要精确对准才能触发。

现改为 **「窗口左边缘 → 对话内容列左边缘」这段留白的 40%**
（`triggerRatio`，可配置；最初试过 70%，随后按要求收窄到 40%）。

关键在于「对话内容列左边缘」不能靠猜 —— 官方 `ui-chat` 的正文列是**居中**的：

```css
/* 官方 ui-chat：.column */
max-width: var(--dsh-chat-content-width); width: 100%; margin: 0 auto;

/* 官方 ui-conversation：写在 [data-conversation-content] 上 */
--dsh-chat-content-width: var(--dsh-chat-user-width,
  clamp(680px, 中栏宽 * .64, 920px));
```

所以「内容列左边缘」= 容器左边缘 + (容器宽 − 内容列宽) / 2。以真机截图
（窗口 1020px）核对：内容列宽 `clamp(680, 652.8, 920) = 680`，左边缘
`(1020 − 680) / 2 = 170` —— 与截图中量到的正文/输入框左边缘（x≈170）一致。

热区则按当前比例算：`ceil(170 × 0.4) = 68`。

> 那张截图上当时手绘的绿框右边缘约在 x≈120（那是 70% 的位置）。比例后来按要求
> 收窄到 40%，所以**现在的热区比那个绿框更窄**，这是预期的。
> 「内容列左边缘 = 170」这个基准仍由截图证实，改的只是乘数。

实现要点：

1. **取值用官方契约，不碰哈希类名**：定位 `[data-conversation-content]`
   （官方 `data-conversation-content` 属性，是 ui-conversation 的公开标记），
   按官方公式算内容列宽度：`clamp(680, 中栏宽×.64, 920)`。
   > **不能图省事去读 `--dsh-chat-content-width` 的 computed value。** 用
   > headless Chrome 实测（1020px 视口）它返回的是
   > `clamp(680px, calc(1020px * .64), 920px)` —— 自定义属性只替换 `var()`，
   > **不求值** `clamp()` / `calc()`，`parseFloat` 得到 NaN。所以那条路在真实
   > 浏览器里从不生效。只有当值是**纯数值**（用户拖拽过宽度时官方写 `Npx`）
   > 才采用，否则一律走公式。测试桩也按这个真实行为模拟（返回 token 流），
   > 否则桩会比浏览器"更聪明"、给出虚假的安全感。
2. **必须取「主对话区」那一个**：这个属性**不止一处** —— 官方 `ui-subagent`
   的「子智能体对话」在右侧栏里经 `sidebar.chat.conversation` →
   `conversation.content`（`variant: 'embedded'`）渲染**同一个**组件，于是页面上
   会同时有两个 `[data-conversation-content]`。右侧栏那个实例在窗口右边、容器
   窄得多，误用它算「内容列左边缘」会得到大出一个量级的值（1020px 窗口下热区
   会从 68 变成 280，盖住小半个窗口）。插件用官方右侧栏容器标记
   `data-sidebar-right-session` 显式排除，并用 `querySelectorAll` 逐个筛。
3. **上边界取对话内容容器的顶边**（= 对话区 header 底边），并与窗口标题栏底边
   取较大值。这样「对话 / 轨迹 tab、会话标题」那一条整块被排除 —— 这是用户
   报告的缺陷：原先上边界只有窗口标题栏（Windows 上 40px），header（76px）
   整条都在热区里，点 tab 或标题就会浮出侧边栏。**不写死 76px**，因为官方
   header 高度是可变的（无 tab 的 `headerBlank` 变体是 `min-height:0`），读
   body 的实际顶边才能自动适配。
4. **热区边界向上取整到整像素**：按比例算可能得到 `x.999999…`（0.7 时
   `170 × 0.7` 在 IEEE754 下是 `118.99999999999999`），不取整则整数阈值落在
   热区**外**，与文档写的数字差 1px、边界不可预测。取整后「文档里写的数字」就是
   「实际能触发的最后一像素」。0.4 下各值恰好是整数，但 `ceil` 仍是在位保险。
5. **绝不给热路径加负担**：测量只在冷路径（初始、`resize`、开合瞬间、指针在
   热区外时最多每 500ms 一次）。同时把**折叠态判定**的元素查询也缓存了 ——
   原先每次 `pointermove` 都跑一次 `querySelector('[class$="_frame"]…')`，
   热区扩大后指针在区域内停留时间显著变长，这个查询不再适合留在热路径上。
   实测「已打开 + 热区内移动 50～200 次」时 `getComputedStyle` /
   `getBoundingClientRect` / `querySelector` **全部为 0 次**（已固化为断言）。
6. **命中后复核**：缓存值偏大时（中栏刚变窄）指针可能其实已在热区外，直接用
   缓存会「打开→立刻收起」抖一下，所以在真正要打开的那一次重测确认。
7. **保持原有防止振荡的结构**：热区仍算作「打开区域内」，指针移出热区（右侧
   60%）或离开窗口才收回 —— 否则按比例放大的热区配上 280px 的卡片就可能每帧开合。

回归断言，且**对新旧实现给出不同结果**（已实测）：

| 层 | 断言 | 反向验证结果 |
|---|---|---|
| `test.mjs`（34 项） | 纯函数：内容列宽度钳制、40% 比例、ratio 越界夹取、窄容器退化、容器左移、**真实 token 流下回落公式**、**上边界取较大值且不产生 NaN** | `trigger: 24` → 失败 |
| `apply-check.mjs`（24 项） | 接线：1020px 窗口下 x=60 触发、x=100 不触发；**对话区 header 内（y=41/60/90/100/114）不触发**、**header 之下（y=120）触发**、**上边界之上（y=115）不触发**；**两个对话区时按主对话区算**；**只剩右侧栏对话区时不误用其几何**；**主对话区缺失时走视口兜底**；时钟回拨后仍能重测 | `trigger: 24` → **失败 8 项**；`ratio: 0.7` → **失败 2 项**；上边界退回只用标题栏 → **失败 4 项** |
| `visual-check.mjs`（9 项） | 真实浏览器里热区 = `ceil(内容列左边缘 × 0.4)`；**上边界 = 真实渲染出的 header 底边** | `ratio: 0.7` → 失败；上边界退回只用标题栏 → **失败 3 项**（`pluginTop=40` vs `bodyTop=116`） |

`apply-check.mjs` 与 `visual-check.mjs` 那几项是关键 —— 纯函数正确不代表接线
正确，它们用真实几何走状态机 / 真实浏览器渲染，直接证明「热区真的按比例接上了」
「取的是正确的那一个对话区」「header 真的被排除」。

> header 那条断言的反向验证值得单独记一笔：把上边界改回「只用窗口标题栏」后，
> `visual-check.mjs` 报出 `pluginTop=40 bodyTop=116` —— 精确复现了用户报告的现象
> （顶部整条可触发）。断言不是摆设。

> 比例从 70% 收窄到 40% 时，`apply-check.mjs` 里有**两个判别点必须同步重算**，
> 否则断言会静默失去区分力：
>   · 「未误用右侧栏实例」的判别点：误用后的热区从 `ceil(700×0.7)=490` 降到
>     `ceil(700×0.4)=280`，所以判别点要从 `x=400` 改到 `x=150`（仍在 68 之外、
>     280 之内）。
>   · 「低频重测生效」的判别点：内容列改成 200px 后热区从 287 降到 164，判别点
>     从 `x=250` 改到 `x=100`。
> 另外 `repro-hover-flicker.mjs` 的「热区比卡片宽」场景在 40% 下 1920px 窗口
> **不再成立**（热区 200 < 卡片右缘 288），实测需要窗口 ≥2361px，因此改用
> 3000px 窗口（热区 416）。

> 第 2 条是复查时发现的**真实缺陷**，不是假想：`ui-subagent` 的
> `sidebar.chat.conversation` 确实会再渲染一个 `[data-conversation-content]`。
> 回归断言刻意把右侧栏实例排在**文档顺序更前**，确保考的是排除逻辑本身，
> 而不是碰巧顺序正确；去掉排除逻辑后该断言精确失败。

---

## 验证

无需浏览器即可跑的五套（共 433 项），全部通过：
```bash
node test.mjs                 # 纯函数 + CSS 契约 + token 白名单 + 账号/设置绑定（206 项）
node smoke.mjs                # 组件渲染烟雾（70 项，真实执行组件体）
node apply-check.mjs          # apply 级集成（115 项，Cordis + DOM 桩）
node layout-check.mjs         # CSS 选择器 × 真实 DOM 的间距契约（28 项）
node repro-hover-flicker.mjs  # 鼠标触发闪烁的逐帧复现（14 项）
```

另有两套需要 headless Chrome 的：

```bash
node visual-check.mjs         # 真实渲染 + 几何测量（52 项，含顶栏几何 12 项）
node e2e-profile.mjs          # 个人信息按钮端到端（19 项：座位链 → 真开设置）
```

各套测试**各有分工，不能互相替代**：

| 脚本 | 覆盖什么 | 抓得到什么 |
|---|---|---|
| `test.mjs` | 纯函数（派生、排序、可见性、搜索）+ 生成的 CSS 文本 + 账号/设置解析 | 逻辑错误、CSS 契约被破坏、token 拼写错误、走错打开设置的 API |
| `smoke.mjs` | **真实执行组件体** | hooks 顺序违规、渲染期 `undefined` 访问、降级路径、点击是否真开设置 |
| `apply-check.mjs` | **真实调用 `apply`** | 接线错误、服务缺失、注册面形状、dispose 泄漏、指针状态机振荡 |
| `layout-check.mjs` | **CSS 选择器 × 真实 DOM 树** | 选择器与 DOM 层级脱节导致的「静默失效」样式 |
| `visual-check.mjs` | 真实浏览器几何 | 「不挤压中栏」与顶栏排布是否真的成立 |
| `e2e-profile.mjs` | **官方座位链 → 真点按钮 → 官方 store 变 open** | 账户/设置接线是否真的走通（含「点了没反应」这一类静默失败） |
| `repro-hover-flicker.mjs` | 逐帧模拟指针 + 过渡动画 | 鼠标触发的开合振荡（闪烁抽搐） |

> `e2e-profile.mjs` 的前一版给 `openSettings` 传的是**测试桩回调**，于是
> 「点头像 → 点设置没反应」这个真实缺陷一路绿灯：桩被调用、断言通过，而真实
> 路径（`ctx.shortcuts.invoke`）根本不存在。现在它只用插件自己的解析函数
> （`__resolveOpenSettings`），并断言**官方 store 的 `open` 真的变成 true**。

> `visual-check.mjs` 的 React 桩曾经有一个**静默假通过**的缺陷：它把
> `createElement(Comp, { children: x })` 的显式 `children` 用空的 rest 参数覆盖掉，
> 于是所有「通过 props.children 传子节点」的组件（官方 `Tooltip` 与本插件的
> `TooltipFallback` 都是这种）在桩里都渲染成空。结果几何断言全部通过，而
> **新会话按钮其实从没被渲染出来过**。桩已按 React 语义修正（显式 `children`
> 保留，rest 有值时覆盖），并补了顶栏几何断言 —— 现在这种情况下会直接失败。

> 热区改为按比例算之后，`repro-hover-flicker.mjs` 多出两个场景（E/F）。原因是
> 这引入了**以前不存在**的几何：旧热区固定 24px，永远落在卡片（8..288）之内，
> 「在热区内」≈「在卡片内」；按比例算之后热区可以超过卡片右缘 288。于是新增
> 两类必须验证的情况：指针停在「卡片右缘之外、热区之内」必须保持打开（场景 E），
> 停在「热区之外」必须收起（场景 F）。
>
> 注意 40% 下这个场景**需要足够宽的窗口**才能构造出来：1920px 窗口的热区只有
> 200（仍在卡片内），实测要 ≥2361px 才超过 288。所以测试用 3000px 窗口
> （热区 416）。70% 时 1920px 就够（热区 350）—— 收窄比例后这个前提变了，
> 断言里的常量必须跟着改，否则场景会退化成「热区比卡片窄」而失去意义。

`layout-check.mjs` 是无需浏览器的几套里**唯一**把「生成的选择器」和「真实
渲染出的 DOM 树」对起来求值的。它存在的原因是两个已经发生过的真实缺陷：

1. **相邻会话行的背景粘连**。间距规则写成了
   `[data-dsh-fso-list-area] > * > * + *`，而插件 DOM 是
   `list-area → tree-body → list-scroll` 的**单链**——相邻兄弟选择器要求左侧
   存在兄弟元素，`list-scroll` 没有兄弟，于是这条规则一个元素都匹配不到，
   行间距全程为 0。两个相邻行同时显示背景（一个选中、一个 hover）时就粘成
   一块。`test.mjs` 只查 CSS 文本里有 `margin-top: 2px`（有），`smoke.mjs`
   只查 DOM 里有 `data-dsh-fso-session-row`（也有），**两者拼不起来**。
2. **底部渐隐是死的**。`tree-body` / `list-scroll` / `fade` 三个属性渲染了
   DOM 却完全没有对应 CSS。

该脚本自带**选择器匹配器自检**（子代 / 相邻兄弟 / 后代 / `* + *` 在单链上
不命中），若匹配器本身出错会先失败 —— 避免「验证工具坏了导致假通过」。


`test.mjs` 的关键断言：生成的 CSS **不含** `grid-template-columns`、
不含 `!important`、不引用官方哈希类名、用 `transform` 而非 `left`。

它还持有一份**官方 design token 白名单**。拼错的 token 不会报错、只会静默失效
（`var(--typo)` 解析为无效值，声明被丢弃），是最难察觉的一类 bug —— 开发中确实
踩过两次（把 `state-warn-primary` 写成 `state-warning-primary`、
把 `bg-layer-1` 写成 `bg-elevated`），所以固化成回归防护。

`apply-check.mjs` 用最小 Cordis + DOM 桩真实跑一遍 `apply`，断言：样式注入
`<head>`、`locale` 字典 zh/en 键集一致、快捷键默认值含桌面与 Web、`shell.overlay`
注册的 id/locale 正确、注入面 17 个字段齐全、11 个业务回调真的转发到服务、
总开关 `toggle/enable/disable` 生效、dispose 后样式与 `<html>` 属性都被清理。

`visual-check.mjs` 用**官方 frame / overlayLayer 的真实 CSS** 搭仿真页，把本插件
的节点套上去，在 headless Chrome 里测量几何：

| 断言 | 结果 |
|---|---|
| 关闭态卡片在视口外、透明、不拦截指针 | ✓ |
| 打开态滑入到位（left = gap）、不透明、可交互 | ✓ |
| 卡片宽度 = 280px、圆角 = 16px、有投影 | ✓ |
| 浮层从标题栏下方开始（top = 48） | ✓ |
| 卡片底边贴视口底，留白正好 = gap | ✓ |
| 插件自己的节点不越出卡片矩形 | ✓ |
| **开合全程官方 grid 只有一种取值** | ✓ |
| **中栏 left / width 全程不变** | ✓ |
| 侧边栏列宽未被改动 | ✓ |
| **热区 = ceil(对话内容列左边缘 × 0.4)**（且大于旧的 24px） | ✓ |

> 需要 headless Chrome 能启动。受限沙箱下 Chrome 会因 crashpad
> `OpenProcess: 拒绝访问` 起不来，此时脚本报 SKIP 并以退出码 0 结束
> （这是环境限制，不是插件缺陷）。

---

## 已知限制

1. **不渲染第三方扩展位**：别的插件注册在官方侧边栏上的扩展
   （`sidebar.workspaces.session.menu.item`、`.row.action`、
   `sidebar.session.row.leading`、`.hover`、`sidebar.panellist`、
   `sidebar.settings`、`sidebar.footer.action`）**不会**出现在本插件的浮层里。
   原因是 slot 的「声明即认领」规则，见上。
2. **不含全局面板图标**：那是 `sidebar.panellist` 座位，被官方独占，折叠态
   浮层里因此没有「插件」等面板按钮。
   两个例外，都是**只借用数据、不占用座位**：
   - **个人信息按钮**：读 `settings.launcher` 条目的 `account` source 画头像，
     并从 `sidebar.settings` 条目的 store 调 `actions.open()` 打开设置弹窗
     （只保留「设置」这一件事，见上文「个人信息按钮」一节）。
   - 设置弹窗本体仍由官方 `sidebar.settings` 渲染，本插件只是把它**叫出来**。
3. **依赖官方 hook 名**：`useSessions` / `useSessionStatus` / `useWorkspaces` /
   `usePanelInfo` 来自官方 `provideRoot`，官方改名会失配（此时组件降级为空列表
   并在控制台告警，不会崩）。
4. **依赖官方 primitives 模块**：模块表里它是 baseline external，正常都在；
   若被移除，UI 降级为内置最简实现（无菜单/悬停卡）。
5. **归档「停止并归档」的错误识别靠 `rpcError.details.activity`**：跨 bundle 没有
   class identity，官方自己也靠 `error.name` 判断，这里读的是错误对象上的字段。
6. **热区依赖官方的对话区标记与宽度变量**：定位用 `[data-conversation-content]`
   （ui-conversation 的公开属性），宽度优先读计算后的 `--dsh-chat-content-width`。
   两者都失效时回退到按视口推算的近似值（折叠态中栏≈视口宽），热区仍然可用，
   只是不再精确跟随内容列；不会有报错或崩溃。
7. **未在 DSH 真机端到端跑过**：本机 DSH web 需要 launch token 才能连，所以验证
   走的是「官方 CSS 仿真页 + headless Chrome」。真机上建议确认：
   ```js
   document.querySelector('[data-dsh-fso-card]')
   ```

---

## 文件

| 文件 | 作用 |
|---|---|
| `client.js` | 浏览器半：全部逻辑（CSS + 派生 + React 组件 + 浮层注册） |
| `index.js` | 宿主半：空实现，仅用于挂进插件树 |
| `cordis.patch.yml` | bundle patch：`insert` 条目（id `sidebar-overlay`） |
| `package.json` | `dsh.client` 声明：web 平台、立即加载 |
| `test.mjs` | 纯函数 + CSS 契约 + token 白名单 + 账号/设置解析（206 项） |
| `smoke.mjs` | 组件渲染烟雾（70 项，含顶栏排版与点击开设置） |
| `apply-check.mjs` | apply 级集成测试（115 项） |
| `layout-check.mjs` | CSS 选择器 × 真实 DOM 的间距契约测试（28 项） |
| `repro-hover-flicker.mjs` | 鼠标触发闪烁的逐帧复现（14 项） |
| `visual-check.mjs` | headless Chrome 真实渲染几何验证（52 项，含顶栏几何 12 项） |
| `e2e-profile.mjs` | 个人信息按钮端到端验证（19 项：座位链 + 真开设置弹窗） |

## 卸载

在「插件」页卸载，或者：

```bash
dsh plugin --profile web remove dsh-sidebar-overlay
```

然后重启 DSH。卸载时会移除注入的样式与 `<html>` 上的标记属性，不留残状态。
