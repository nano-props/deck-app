# Web 端 React 重构备忘

合并 `docs/index.html`（营销主页）和 `docs/player/`（vanilla web player）成一个独立的 React 静态站点。本备忘记录了**已经决定的事**、**待办**、和**当前 vanilla 实现里所有需要保留的边角行为**——下次会话可以直接接着干。

---

## 1. 已经决定的事

### 1.1 项目位置 & 命名

- 新项目放在 `src/web/`
- 与 `src/main/`（Electron 主进程）/ `src/renderer/`（Electron 渲染）形成对称的部署目标
- Build 输出到 `dist/web/`

### 1.2 范围

合并两个站点：
- 主页（当前 `docs/index.html`，1975 行）
- Web player（当前 `docs/player/*`，约 2200 行）

完成后 vanilla 版本（`docs/index.html` 和 `docs/player/`）整个删除。

### 1.3 技术栈（与 `src/renderer/` 对齐）

| 维度 | 选择 |
|---|---|
| 框架 | React 19 + TypeScript（strict） |
| 构建 | Vite + `@vitejs/plugin-react` |
| 样式 | Tailwind v4（`@tailwindcss/vite`），辅以 `tailwind-variants` / `clsx` / `tailwind-merge` |
| Icons | `lucide-react` |
| 状态 | Zustand |
| 路由 | **MPA 多入口**（不用 React Router） |
| 路径 alias | `#/*` → `./src/*`（沿用 monorepo 已有约定） |
| 部署 base | `base: './'`（相对路径，部署位置由用户自处理） |

### 1.4 路由模式：MPA

不用 SPA + React Router。使用 vite 的 `rollupOptions.input` 多 HTML 入口：
- `src/web/index.html`（主页）
- `src/web/player/index.html`（player）

每个入口是独立 SPA。GitHub Pages 这类静态托管对此原生支持，刷新可靠。

### 1.5 依赖

- **JSZip** 写进 `package.json`（不再走 unpkg CDN，让 vite bundle 进去）
- 其他依赖跟随 renderer 的 `package.json`

### 1.6 Service Worker 处理

vite 没有完美的 SW 抽象。选定方案：

- 把 `sw.ts` 当作 vite 多入口之一，但**输出文件名固定**（不带 hash），因为 SW 注册路径是字面量
- 用 `rollupOptions.output.entryFileNames` 控制 SW 单独输出到 `sw.js`
- 不用 `vite-plugin-pwa`——它是为完整 PWA 设计，我们的 SW 只做内存 deck 路由，配过来要关掉一半特性

参考实现伪代码：
```ts
build: {
  rollupOptions: {
    input: {
      index: 'src/web/index.html',
      player: 'src/web/player/index.html',
      sw: 'src/web/sw.ts',
    },
    output: {
      entryFileNames: (chunk) =>
        chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
    },
  },
}
```

注意 SW 不能 import 普通 ES module（实际上现代浏览器支持 `{type: 'module'}` 的 SW，但兼容性需要测）——保险起见保持单文件，把所需常量内联或独立 lib 用 vite 的 `define` 注入。

---

## 2. 目标目录结构

```
src/web/
├── index.html                     主页入口
├── player/
│   └── index.html                 Player 入口
├── main-home.tsx                  主页 React 挂载
├── main-player.tsx                Player React 挂载
├── App.tsx                        共享 layout 壳（如果有的话；MPA 下也可以不要）
├── pages/
│   ├── HomePage.tsx               主页根组件
│   └── PlayerPage.tsx             Player 根组件
├── home/                          仅主页用到
│   ├── Topbar.tsx
│   ├── Footer.tsx
│   ├── HeroSection.tsx
│   ├── MetaSection.tsx
│   ├── WhatIsSection.tsx
│   ├── HowSection.tsx
│   ├── SkillSection.tsx
│   ├── SecuritySection.tsx
│   ├── CompareSection.tsx
│   ├── EndCtaSection.tsx
│   ├── ThemeToggle.tsx
│   └── LangToggle.tsx
├── player/                        仅 player 用到
│   ├── Stage.tsx                  iframe 舞台 + home indicator
│   ├── DropZone.tsx               拖拽 + 文件选择
│   ├── Hero.tsx                   上传页 hero（标题/tagline/按钮）
│   ├── RecentsList.tsx
│   ├── Palette.tsx                ⌘K 命令面板（用 Radix Dialog）
│   ├── UndoToast.tsx              6 秒倒计时 + 撤销
│   ├── loader.ts                  Loader class（保留现有逻辑）
│   ├── router.ts                  hash routing
│   ├── cache.ts                   Cache API + LRU
│   ├── sw-client.ts               SW 注册 + 协议
│   └── escape-hatch.ts            ?unregister=1 处理
├── lib/                           跨页面工具
│   ├── i18n.ts                    zustand store + t() + 字典
│   ├── theme.ts                   zustand store + light/dark/auto
│   ├── time-format.ts
│   ├── icons.ts                   通用 SVG 工厂（如果不用 lucide）
│   └── cn.ts                      clsx wrapper（沿用 renderer/lib/cn.ts）
├── styles.css                     Tailwind 入口 + 全局 token
└── sw.ts                          Service Worker（独立 entry）
```

---

## 3. 状态管理设计

### 3.1 用 zustand 的地方

| Store | 用途 |
|---|---|
| `useI18n` | 当前语言 + `t(key)`；初值从 `localStorage` 读，否则按 `navigator.language` |
| `useTheme` | 'light' \| 'dark' \| 'auto'；监听系统偏好；持久化 |
| `usePlayerUI` | status / error 文本（player 专用，UI 同步用） |
| `useRecents` | 最近列表的 React 视图（订阅 cache 变化） |
| `usePalette` | open/closed + activeIndex |
| `useToast` | 当前 toast spec（或为 null） |

### 3.2 不放 zustand 的部分

**Loader 仍然是 class** ——它已经是状态机 + 副作用协调器，工作良好。React 通过自定义 hook (`useLoader`) 拿到一个稳定引用 + 订阅它的状态变化。

**Router 仍然是 factory function** ——hash 监听不变。React 组件订阅当前 hash。

### 3.3 Loader → React 的桥

```ts
// hooks/useLoader.ts
const loaderRef = { current: null as Loader | null }

export function useLoader() {
  if (!loaderRef.current) loaderRef.current = new Loader({...})
  return loaderRef.current
}

// 把 Loader 内部状态变化通过 callback 同步到 zustand，
// 让 React 组件用 zustand 订阅、不用直接观察 class 实例
```

---

## 4. 必须保留的边角行为（**不能丢**）

下面每条都是 vanilla 版本里**有意识写的**——React 化时如果丢失会引入回归 bug。

### 4.1 Player 部分

| 行为 | 现在的实现位置 | 原因 |
|---|---|---|
| **deckId = SHA-256 前 96 bit** | `sw-client.js:hashBlob` | URL 短 + 碰撞抗性够 |
| **解压分批 yield**（32 个文件一批 + setTimeout(0)） | `sw-client.js:unpackAndRegister` | 大 deck 不冻 UI |
| **LoadCancelled 异常类**（不是 Error） | `sw-client.js` | 在 `withGuard` 静默吞，不显示给用户 |
| **isCurrent 回调传到 unpackAndRegister** | `loader.js:doLoadFromFile` | 用户中途取消时立刻 abort |
| **loadGeneration 计数器** | `loader.js` | 防止 stale load 完成后 hijack 舞台 |
| **commit 不能在 await 之间** | `loader.js:commit` 注释 | 否则有 race。**React 化时尤其要小心**——别把 commit 拆到 useEffect 异步链 |
| **isLoading 互斥**（drop 二次拖拽静默拒绝） | `loader.js:withGuard` | 单线程语义清楚 |
| **cache miss → 显示 "URL 不能分享" 提示** | `player.js:onHash` 'missing' 分支 | 用户教育 |
| **quota 错误不致命**（cache 写失败仍展示 deck，不加 hash） | `loader.js:doLoadFromFile` | UX 优雅降级 |
| **soft delete + commit 比对 ts** | `cache.js:commitDeleteDeck(deckId, softEntry)` | 防止"删除→立即重新拖入同 deck→6s 后误删" |
| **删除立即从列表消失，commit 推迟 6s** | `player.js:handleDelete` + `undo-toast.js` | Gmail 模式 |
| **toast 替换时先 commit 旧的** | `undo-toast.js:show` | 多次删除时上一个不会被 abandon |
| **SW 重启 recovery：notify + re-register + 重设 iframe.src** | `loader.js:recover` + `sw.js:notifyDeckMissing` | 闲置 SW 被浏览器回收后 iframe 不破损 |
| **SW recovery 也走 isCurrent**（中途用户切 deck 时 abort） | `loader.js:recover` | 不浪费 CPU 解压 |
| **SW notifyDeckMissing 走 event.waitUntil** | `sw.js:fetch handler` | 否则 SW 可能在 postMessage 之前被回收 |
| **deckId is content hash; HTML cache no-cache, others immutable** | `sw.js:serveDeckFile` cacheControl 计算 | HTML 必须 revalidate（避免 deck 关闭后 disk cache 复活时子资源 404）；其他资源永久缓存 |
| **Range request 支持 (206)** | `sw.js:serveDeckFile` | 视频可 seek |
| **decodeURIComponent safeDecode** | `sw.js:safeDecode` | 异常 URI 不让 SW 崩 |
| **iframe `allow="fullscreen"`** | `index.html` | deck 调 requestFullscreen 才能 work |
| **iframe sandbox `allow-scripts allow-same-origin`** | `index.html` 注释 | 已知不是真沙盒——deck 必须可信 |
| **`?unregister=1` escape hatch** | `player.js:handleEscapeHatch` | player 死掉时用户能自救 |
| **刷新带 hash 不闪首页** | `index.html` head 内联脚本 + CSS `.restoring` | 内联同步执行避免 paint 一帧首页 |
| **Stage z-index > Topbar，避免 :has() 触发刷新闪屏** | `index.html` CSS `#stage z-index: 50` | 之前用 `body:has(...)` 触发了 Safari 重计算延迟，已抛弃 |
| **status 和 error 互斥显示** | `player.js:setStatus/setError` | 不并存"Loading…"和错误 |
| **同一文件连续选两次也触发 change** | `player.js` `e.target.value = ''` | 浏览器默认行为限制 |
| **browse button 不嵌套 `<input>`** | `player.js`：用 `<button>` + `fileInput.click()` | label + nested input 在某些浏览器双触发 file picker |
| **palette focus trap (Tab 在 items 内循环)** | `palette-ui.js:handleKey` | 模态对话框 a11y |
| **palette open 同步显示 actions，异步 append recents** | `palette-ui.js:open/renderRecents` | 几十毫秒 cache.match 不卡 palette 出现 |
| **palette openGen 防 stale render** | `palette-ui.js` | 异步 recents 完成时 palette 已经被关→重开过会污染新 session |
| **palette 不用 history.back()** | `player.js:onBack` | deck 内部可能 push 历史；back 会回 deck 内部状态而非 player 上传页 |
| **home indicator + mix-blend-mode: difference** | `index.html` CSS `#home-indicator` | 在任何 deck 背景上自动反差。background 用纯白，hover 只改 opacity（防 blend math 跳变） |
| **delete button hover-only 显示** + `@media (hover: none)` 强制可见 | `index.html` CSS `#recents .delete` | 桌面干净 + 触屏可点 |
| **list item hover translateY -1px + soft shadow** | `index.html` CSS | 和 docs `.sec-item` 一致 |
| **time format 用 floor 不 round** | `lib/time-format.js` | "1.9 days ago" 显示为 "1 day ago" 更符合直觉 |
| **LRU eviction 按 ts 升序，孤儿 ts=0 最先驱逐** | `cache.js:evictIfNeeded` | 兼容旧版本数据 |
| **MAX_CACHED_DECKS = 20** | `cache.js` | 上限可配 |
| **Cache 和 LRU key 不带 app prefix**（保持 `deck-blobs-v1`/`deck-cache-lru-v2`） | `cache.js` 注释 | 改名会让现有用户数据失效 |

### 4.2 Home 页部分

| 行为 | 来源 | 原因 |
|---|---|---|
| **i18n 字典只有 en/zh** | `docs/index.html` 内联 I18N | 当前没有更多语言 |
| **lang 切换持久化** | `docs/index.html` `localStorage.setItem('lang', ...)` | 用户偏好保存 |
| **theme: light/dark/auto** | `docs/index.html` themeBtn | auto 跟随系统；切换轮转 |
| **`reveal` class 入场动画** | `docs/index.html` IntersectionObserver | 滚动到视口才淡入。React 化时改用 `useInView` 或 framer-motion，**也可以保留原生 IO** |
| **`html.no-js` class 移除** | `docs/index.html` 第一行 JS | 加载完才显示动画相关。React 化时不需要——React 必须 JS |
| **顶部 nav sticky + backdrop blur** | docs CSS `.topbar` | 和 player 已对齐过 |
| **footer 链接** | docs HTML | 包含 GitHub、player、各 section 锚点 |
| **section 锚点跳转 (#whatis 等)** | HTML id + `<a href="#...">` | `data-i18n` 在文本上，href 不变 |

### 4.3 共享视觉 token

```css
/* light theme */
--bg: #fafaf9
--surface: #ffffff
--ink: #111111
--ink-2: #3a3a3a
--mute: #787c82
--line: #e6e6e2
--line-2: #cdcdc7
--accent: #2f6bff
--chip: #f0f0ec   /* 仅 home 用 */

/* dark theme（home 有，player 现在没） */
--bg: #0c0d0f
--surface: #121417
--ink: #f2f3f5
--ink-2: #c9cbce
--mute: #8a8e95
--line: #1f2226
--line-2: #2d3138
--accent: #5d8dff
--chip: #181b1f
```

字体栈：
```
'Inter', 'PingFang SC', 'Noto Sans SC', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif
```

`html[lang='zh']` 优先 PingFang SC（zh 字体规则）。

### 4.4 Favicon（共享）

Inline SVG data URL，已在两处用：
```html
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg ..."/>
```

参考 `docs/index.html` line 11-15。

---

## 5. 工作量估算 & 推荐分步

总估 ~13 小时实施 + 测试（不含审查时间）：

| 阶段 | 工作 | 估时 |
|---|---|---|
| 1 | 脚手架（vite/tsconfig/Tailwind/包安装/路径 alias） | 1h |
| 2 | 共享 lib（i18n、theme、time-format、icons、cn） | 1h |
| 3 | Player 非 UI 模块 TS 化（loader/router/cache/sw-client/sw） | 1.5h |
| 4 | Player UI 组件（DropZone、Stage、RecentsList、Palette、UndoToast） | 3h |
| 5 | Home 共享组件（Topbar、Footer、ThemeToggle、LangToggle） | 1.5h |
| 6 | Home 8 个 section 组件（Hero、Meta、WhatIs、How、Skill、Security、Compare、EndCta） | 3h |
| 7 | Wire + 测试边角 + 删除 vanilla | 2h |

### 推荐分步

**Step A（一次会话能做完）**：阶段 1-4 + 阶段 7 的 player 部分。产出能完整跑的 player。

**Step B（下次会话）**：阶段 5-6 + 阶段 7 的 home 部分 + 删除 vanilla。

Step A 完成后 player 可以替换当前 vanilla player；home 暂时留 vanilla 不动。

或者**一次全做**：会输出 30+ 文件、上千行——审查成本高，但确实能一次搞定。

---

## 6. 测试清单（重构完做完必须 pass）

### Player 路径

- [ ] 拖文件 → 上传成功 → URL 加 `#hash` → 显示 deck
- [ ] 选择文件（点 browse 按钮） → 同上
- [ ] 选同一文件两次 → 都触发加载
- [ ] 拖**坏的** zip → 显示错误信息
- [ ] 拖**缺 deck.json** zip → "Invalid deck: missing deck.json"
- [ ] 大 deck（500+ 文件）解压 → UI 不冻
- [ ] 加载到一半按 ⌘K 返回 → 立刻回上传页，不会"加载完后舞台又冒出"
- [ ] 刷新带 hash URL → 直接显示 deck，不闪首页
- [ ] cache miss URL → 显示"URL 不能分享"提示
- [ ] 浏览器后退 → 从 deck 回到上传页
- [ ] 删除 recent → 立刻消失 + 6 秒倒计时 toast → undo 恢复 / 6 秒后真删
- [ ] 删除一个 deck 后立刻拖入同一 deck → 6 秒后不会误删
- [ ] 连续删除两个 deck → 第一个 toast 切到第二个，第一个被 commit
- [ ] ⌘K / ? → 打开 palette
- [ ] palette 内 ↑↓ Enter Esc Tab Shift+Tab Home End → 全部可达
- [ ] 点击 home indicator → 打开 palette
- [ ] palette 选 "Back to library" → 回上传页
- [ ] palette 选 recent deck → 切到该 deck
- [ ] 长时间挂着 deck（让 SW idle 重启）→ iframe 自动 reload，deck 仍可用
- [ ] 视频 seek（如果 deck 有视频）→ Range request 工作
- [ ] `?unregister=1` → 清理完成 + 显示提示
- [ ] 没 JS → 显示"Requires JavaScript"
- [ ] iframe sandbox + fullscreen 仍 work

### Home 路径

- [ ] 首屏渲染（hero）OK
- [ ] zh/en 切换 → 所有 `data-i18n` 文本切换
- [ ] light/dark/auto 切换 → 配色生效，持久化
- [ ] 系统切 dark mode → auto 跟随
- [ ] Section 锚点跳转（点 nav）
- [ ] reveal 动画（scroll into view 时淡入）
- [ ] "Open Player" 链接跳到 `/player/`
- [ ] favicon 显示

### 跨页面

- [ ] 主页和 player 视觉风格一致（token、字体、圆角等）
- [ ] 中文 deck 名 PingFang 渲染正常
- [ ] favicon 两边都用同一份

---

## 7. 已知遗留 / 不在重构范围

不要试图在重构里"顺手解决"这些——会扩大 scope：

- **deck 内可信代码假设**：iframe `allow-same-origin` + `allow-scripts` 不是真沙盒。文档化在注释里，将来如果支持不可信 deck 需要单独 origin
- **PostMessage 不用 Transferable**：register-deck 时所有 Uint8Array 走 structured clone（会复制）。优化点，没遇到 OOM 不动
- **多 tab 不同步 LRU**：localStorage storage 事件没监听。用户极少多 tab，不修
- **palette 关闭后焦点恢复**：previouslyFocused 可能是 iframe 内 dead element，focus 静默失败。已知限制
- **关 tab 时 toast 没 commit**：cache 里 blob 留着但 LRU 已删——orphan 由后续 evict 清理。可接受
- **deck 改顶层 history**（同源 iframe 能访问 parent）：palette 返回不用 history.back 已经规避；其他场景如果用户报问题再处理
- **deck 自己注册 SW 冲突**：deck 不该这么做，sandbox 没法防御
- **deck 写入 player 的 localStorage**：同上，sandbox 限制

---

## 8. 当前 vanilla 实现文件清单

迁移完成后**全部删除**：

```
docs/
├── index.html              ← 主页 vanilla 版
└── player/
    ├── index.html
    ├── player.js
    ├── loader.js
    ├── router.js
    ├── cache.js
    ├── sw-client.js
    ├── sw.js
    ├── recents-ui.js
    ├── palette-ui.js
    ├── undo-toast.js
    ├── time-format.js
    └── icons.js
```

新的 `dist/web/` build 输出会替换它们的位置（按 `base: './'` 部署）。

---

## 9. 重要风险

1. **Step A 完成时 vanilla 还在**：Build 输出和 vanilla 的 URL 可能冲突。要么先**只迁移 player** → 部署到 `/player/`（覆盖 vanilla player），主页留 vanilla；要么**等 Step B 完成**再切。
2. **SW scope 不一致**：vanilla SW 在 `/player/` scope，新版可能改成 `/`（取决于部署路径）。**用户浏览器里的旧 SW 会和新 SW 共存一段时间**，需要考虑老 SW 的清理策略。
3. **localStorage / Cache 数据迁移**：保留 `deck-blobs-v1` 和 `deck-cache-lru-v2` 这两个 key——用户的本地数据无缝迁移。
4. **i18n 翻译 key 不能改名**：当前 `data-i18n="navWhat"` 等 key 已经在 vanilla 里，迁过去保持名字一样，避免翻译丢失。

---

## 10. 下次会话直接说

> "按 docs/web-refactor-plan.md 的 Step A 做"

或

> "按 docs/web-refactor-plan.md 一次性做完"

我能直接接着干，不必重新讨论已经决定的事项。
