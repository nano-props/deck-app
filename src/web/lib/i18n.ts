// Web-side i18n: en/zh dictionaries lifted verbatim from the vanilla
// `docs/index.html` (so existing translation keys keep working). Values
// may contain trusted HTML — `<T>` renders via dangerouslySetInnerHTML,
// matching the vanilla `el.innerHTML = val` behavior.
//
// Detection: `localStorage` ("lang" key, kept for migration) → first
// matching `navigator.languages` entry → `'en'`. Persistence is a
// straight `localStorage.setItem`; nothing else listens for storage
// events because we don't expect the same user to drive the page from
// two tabs.

import { create } from 'zustand'

const LANGS = ['en', 'zh'] as const
export type Lang = (typeof LANGS)[number]

const LS_KEY = 'lang'

const EN = {
  navWhat: "What's a Deck",
  navHow: 'How',
  navPlayer: 'Open Player',
  navCta: 'GitHub →',
  heroTitle: 'Slides, reinvented.',
  heroLead:
    'Tell your AI what you want to present — and open a real deck on your desktop.',
  heroCta1: 'Get Deck',
  heroCta2: 'See AI in action',
  heroTip:
    'Opens <span class="mono">.deck</span> files and plain <span class="mono">.html</span> — a <span class="mono">.deck</span> is just a zipped web page.',
  mockTitle: 'Q3 <em>Performance Review</em>.',
  mockBody:
    "Where we stood, where we're going — 12 slides from a single prompt.",

  metaK1: 'file to share',
  metaK2: 'Deck accounts to sign up',
  metaK3: 'works offline, forever',
  metaK4: 'platforms · Mac &amp; Windows',

  insideKicker: 'What goes in',
  insideTitle: 'Put anything on a slide.',
  insideSub:
    "Photos, charts, videos, your logo, a clickable demo — whatever helps you tell the story. Deck doesn't box you into \"title + bullets.\"",
  cName1: 'Photos &amp; images',
  cDesc1: 'Cover shots, product photos, screenshots — drop them right in.',
  cName2: 'Video &amp; audio',
  cDesc2: 'Play a clip, embed a demo reel, autoplay a soundtrack.',
  cName3: 'Charts &amp; data',
  cDesc3:
    'Live charts that update from your numbers, not flat images.',
  cName4: 'Animations',
  cDesc4: 'Fade in a quote. Zoom into a map. Make the moment land.',
  cName5: 'Interactive demos',
  cDesc5: 'A working prototype. A 3D model people can spin. A tiny game.',
  cBasics: 'the basics',
  cExtras: 'when you want more',
  keysKicker: 'On stage',
  keysTitle: "The keys you'd expect, all there.",
  keysSub:
    "Nothing to memorize. Arrow keys turn the page. Space moves you forward. Escape gets you out of full screen. The same keys you've used your whole life.",
  k1: '<b>Page through</b> — back and forward, slide by slide.',
  k2: '<b>Move forward</b> — next slide, next animation, play the video.',
  k4: '<b>Exit full screen</b> — anytime, no panic.',
  k5: '<b>Go full screen</b> — fills the room. No browser bar in sight.',
  k6Label:
    '<span class="mono" style="color: var(--color-mute); font-size: 12px">Clicker</span>',
  k6: '<b>Works too</b> — any presenter remote, plug and go.',
  kLNote: 'Same as Keynote, PowerPoint, Google Slides.',

  s3Kicker: '01',
  s3KickerSub: 'How it works',
  s3Title: 'Three steps, from idea to stage.',
  s3Lead:
    "Nothing to learn. Nothing to set up. Tell your AI what you want — and you're done.",
  s3S1N: 'STEP 01',
  s3S1Title: 'Say what you want.',
  s3S1Desc:
    '"Turn these Q3 numbers into a performance deck." Or drop in your notes, your script, your outline — whatever you\'ve got.',
  s3S2N: 'STEP 02',
  s3S2Title: 'AI builds the slides.',
  s3S2Desc:
    "When it's done, a finished deck lands on your disk — not a link, not a tab in the browser. Yours to keep.",
  s3S3N: 'STEP 03',
  s3S3Title: 'Double-click. Present.',
  s3S3Desc:
    "Full-screen, arrow keys, clicker — same as always. Take it to a meeting room, send it to a colleague, or open it on your phone.",

  skillPill: 'From idea to deck',
  skillTitle: 'Just talk to your AI, like you would a teammate.',
  skillDesc:
    "Tell it what you're presenting, who it's for, how long it should be. Paste in your notes. The AI does the layout, the visuals, the polish — and hands you back a finished deck.",
  skillPath1Name: 'In Deck.',
  skillPath1Desc:
    'Open the built-in editor — chat on the left, your deck live-reloading on the right.',
  skillPath2Name: 'In your AI of choice.',
  skillPath2Desc:
    'Use the <span class="mono">create-deck</span> skill in Claude Code, Cursor, or any agent — it hands you back a finished <span class="mono">.deck</span>.',
  skillCta1: 'Get the skill',
  chatWho1: 'You',
  chatBody1:
    'Make me a 10-slide deck for our coffee app launch. Friendly tone, lots of product shots.',
  chatWho2: 'AI',
  chatBody2: 'On it — outlining the story, picking colors, drafting the slides.',
  chatWho3: 'Done',
  chatBody3:
    '<b>coffee-launch.deck</b> is ready. Double-click to present.',

  s4Kicker: '02',
  s4KickerSub: 'Safe & private',
  s4Title: 'Built to be trusted, by default.',
  sec1Title: 'It stays on your computer.',
  sec1Desc:
    "No uploads, no servers, no analytics. A deck can't phone home or load a tracker — what's in the file is all there is.",
  sec2Title: 'Opens in its own box.',
  sec2Desc:
    "Each deck runs in an isolated window. It can't read your files or peek at other apps — even if someone sends you a shady one.",
  sec4Title: 'Open and inspectable.',
  sec4Desc:
    'A <span class="mono">.deck</span> is not a black box — it\'s the web, zipped. You can always look inside and see exactly what it does.',

  s5Kicker: '03',
  s5KickerSub: "How we're different",
  s5Title: 'The best of every world.',
  cmpH1: 'Gamma / Beautiful.ai',
  cmpH2: 'Keynote / PPT',
  cmpH4: 'Deck',
  cmpR1: 'AI-first authoring',
  cmpR2: 'Your file, your disk',
  cmpR4: 'Web-native interactivity (3D, demos, code)',
  cmpR5: 'Works offline',
  cmpR6: 'Open format',
  cmpYes: 'Yes',
  cmpNo: 'No',
  cmpLow: 'Add-on',

  endTitle: 'Ready <span class="accent">when you are</span>.',
  endCta1: 'Get Deck',
  endCta2: 'Get the skill',

  footHow: 'How it works',
  footSkill: 'The skill',
  footSafe: 'Safe & private',

  // ----- Player-only strings (vanilla used hardcoded English; keys are
  // new but still organized in the shared dict so a future second
  // language flows through one switch). -----
  playerBrand: 'Deck Player',
  playerAbout: 'About',
  playerHeroTitle: 'Play your decks',
  playerHeroTagline:
    'Open any <code>.deck</code> presentation in your browser. Files stay on your device — nothing is uploaded.',
  playerBrowse: 'Choose a .deck file',
  playerBrowseHint: 'or drag a file anywhere on this page',
  playerHeroTip:
    '<kbd>⌘K</kbd> opens the command palette once a deck is open.',
  playerRecents: 'Recently opened',
  playerNoJs: 'This player requires JavaScript.',
  playerUrlNotShareable:
    'This deck is not on this device. The URL only restores decks cached locally — it cannot be shared with others. Drop the .deck file to load it.',
  paletteTitle: 'Commands',
  paletteEsc: '<kbd>Esc</kbd> to close',
  paletteBack: 'Back to library',
  paletteSwitch: 'Switch deck',
  paletteOpenButton: 'Open command palette',
  toastRemoved: 'Removed “{name}”',
  toastUndo: 'Undo',
  errInvalidNoManifest: 'Invalid deck: missing deck.json at the root.',
  errInvalidNoIndex: 'Invalid deck: missing index.html at the root.',
  errInvalidJson: 'Invalid deck: deck.json is not valid JSON.',
  errInvalidNoName:
    'Invalid deck: deck.json is missing the "name" field.',
  statusHashing: 'Hashing…',
  statusUnpacking: 'Unpacking…',
  statusReading: 'Reading files…',
  statusHandoff: 'Handing off to Service Worker…',
  statusCaching: 'Caching…',
  statusRestoring: 'Restoring from cache…',
  unregisterStatus: 'Cleaning up Deck Player data…',
  unregisterDone:
    'Deck Player data has been removed. You can close this tab.',
  unregisterPartial:
    'Cleanup completed with some errors (see console). You can close this tab.',
} as const

export type DictKey = keyof typeof EN
type Dict = Record<DictKey, string>

const ZH: Dict = {
  navWhat: '什么是 Deck',
  navHow: '怎么用',
  navPlayer: '打开播放器',
  navCta: 'GitHub →',
  heroTitle: '幻灯片，重新发明。',
  heroLead: '告诉 AI 你想讲什么 —— 一份能直接上台的演示，就在你的桌面上。',
  heroCta1: '获取 Deck',
  heroCta2: '看看 AI 怎么做',
  heroTip:
    '能打开 <span class="mono">.deck</span> 文件，也能打开普通 <span class="mono">.html</span> —— 一份 <span class="mono">.deck</span> 就是一段打包好的网页。',
  mockTitle: 'Q3 <em>业绩汇报</em>。',
  mockBody: '我们走到哪了，下一步去哪 —— 一句话，做出 12 页。',

  metaK1: '个文件，发给谁都能打开',
  metaK2: '个 Deck 账号要注册',
  metaK3: '离线可用，没有过期',
  metaK4: '个平台 · Mac、Windows',

  insideKicker: '能放什么',
  insideTitle: '一页幻灯片，能装下你的故事。',
  insideSub:
    '照片、图表、视频、品牌 logo、可点击的演示 —— 只要对讲述有帮助的，都能放。Deck 不会把你框死在「标题 + 要点」里。',
  cName1: '照片和图片',
  cDesc1: '封面、产品照、截图 —— 直接拖进来就行。',
  cName2: '视频和音频',
  cDesc2: '播一段宣传片、嵌一份 demo 录屏、配一段背景音乐。',
  cName3: '图表和数据',
  cDesc3: '会随数据更新的实时图表，而不是导出来的一张图。',
  cName4: '动画',
  cDesc4: '让一句话淡入，让一张地图缩进去 —— 把那一刻讲到位。',
  cName5: '互动演示',
  cDesc5: '能跑起来的原型、能旋转的 3D 模型、一个小游戏。',
  cBasics: '基础内容',
  cExtras: '想再进一步',
  keysKicker: '上台时',
  keysTitle: '该有的按键，都在那。',
  keysSub:
    '不用记新东西。方向键翻页，空格往下走，Esc 退出全屏 —— 你这辈子用的都是这些键。',
  k1: '<b>翻页</b> · 前一页、后一页，最自然不过。',
  k2: '<b>往下走</b> · 下一页、下一段动画、视频开始播。',
  k4: '<b>退出全屏</b> · 任何时候，按一下就出来。',
  k5: '<b>进入全屏</b> · 撑满整个会议室，没有浏览器边栏。',
  k6Label:
    '<span class="mono" style="color: var(--color-mute); font-size: 12px">遥控器</span>',
  k6: '<b>也支持</b> · 任何演讲遥控器，插上就能用。',
  kLNote: '和 Keynote、PowerPoint、Google Slides 完全一样。',

  s3Kicker: '01',
  s3KickerSub: '怎么用',
  s3Title: '三步，从想法到讲台。',
  s3Lead: '什么都不用学，也什么都不用装。告诉 AI 你要什么 —— 就完事了。',
  s3S1N: 'STEP 01',
  s3S1Title: '说一句话。',
  s3S1Desc:
    '「把这份 Q3 数据做成一份业绩 Deck」。或者直接把笔记、讲稿、大纲丢过去 —— 你手头有什么都行。',
  s3S2N: 'STEP 02',
  s3S2Title: 'AI 做好整份幻灯片。',
  s3S2Desc:
    '做好之后，一份完整的 Deck 出现在你硬盘里 —— 不是链接，不是浏览器标签页。是真正属于你的一份文件。',
  s3S3N: 'STEP 03',
  s3S3Title: '双击开讲。',
  s3S3Desc:
    '全屏、方向键、遥控器 —— 和你一直用的方式一样。带去会议室、发给同事、在手机上打开都行。',

  skillPill: '从想法到 Deck',
  skillTitle: '像跟同事说话一样，告诉 AI 就行。',
  skillDesc:
    '说一下你要讲的内容、面对的是谁、大概多长。把笔记贴进去 —— 排版、配图、调色，AI 都替你搞定，最后给你一份做好的 Deck。',
  skillPath1Name: '在 Deck 里。',
  skillPath1Desc: '打开内置编辑器 —— 左边和 AI 对话，右边实时预览你的 Deck。',
  skillPath2Name: '在你常用的 AI 里。',
  skillPath2Desc:
    '在 Claude Code、Cursor 或任何 agent 里用 <span class="mono">create-deck</span> skill —— 直接给你一份做好的 <span class="mono">.deck</span>。',
  skillCta1: '获取 Skill',
  chatWho1: '你',
  chatBody1: '帮我给新的咖啡 App 发布会做一份 10 页的 Deck。语气活泼一点，多放点产品图。',
  chatWho2: 'AI',
  chatBody2: '收到 —— 我先理一下故事线，挑配色，把每一页画出来。',
  chatWho3: '完成',
  chatBody3: '<b>coffee-launch.deck</b> 做好了。双击就能开讲。',

  s4Kicker: '02',
  s4KickerSub: '安全 & 私密',
  s4Title: '默认就值得信任。',
  sec1Title: '它就在你电脑里。',
  sec1Desc:
    '不上传、不回传、不埋点。Deck 不能偷偷连网，也不能加载追踪器 —— 文件里有什么，就只有什么。',
  sec2Title: '跑在自己的小盒子里。',
  sec2Desc:
    '每份 Deck 都在独立的窗口里运行。就算别人发了一个可疑的 Deck，它也读不了你的文件、碰不到别的应用。',
  sec4Title: '开放，可检查。',
  sec4Desc:
    '一份 <span class="mono">.deck</span> 不是黑盒 —— 它就是一段打包好的网页。你随时可以打开看看里面到底在做什么。',

  s5Kicker: '04',
  s5KickerSub: '我们有什么不一样',
  s5Title: '把每一类的好处都拿过来。',
  cmpH1: 'Gamma / Beautiful.ai',
  cmpH2: 'Keynote / PPT',
  cmpH4: 'Deck',
  cmpR1: 'AI 是主角',
  cmpR2: '文件在自己电脑里',
  cmpR4: '原生 Web 交互（3D、demo、代码）',
  cmpR5: '离线可用',
  cmpR6: '开放格式',
  cmpYes: '可以',
  cmpNo: '不行',
  cmpLow: '附加功能',

  endTitle: '准备好了，<span class="accent">就来</span>。',
  endCta1: '获取 Deck',
  endCta2: '获取 Skill',

  footHow: '怎么用',
  footSkill: 'Skill',
  footSafe: '安全 & 私密',

  playerBrand: 'Deck 播放器',
  playerAbout: '关于',
  playerHeroTitle: '播放你的 Deck',
  playerHeroTagline:
    '在浏览器里打开任意 <code>.deck</code> 演示。文件留在你的设备上 —— 不会上传到任何地方。',
  playerBrowse: '选择 .deck 文件',
  playerBrowseHint: '或者把文件拖到页面任意位置',
  playerHeroTip:
    '打开 Deck 后，<kbd>⌘K</kbd> 唤出命令面板。',
  playerRecents: '最近打开',
  playerNoJs: '这个播放器需要 JavaScript。',
  playerUrlNotShareable:
    '这份 Deck 不在当前设备上。链接只能恢复本地缓存中的 Deck —— 没法分享给其他人。把 .deck 文件拖进来就能加载。',
  paletteTitle: '命令',
  paletteEsc: '<kbd>Esc</kbd> 关闭',
  paletteBack: '回到 Deck 列表',
  paletteSwitch: '切换 Deck',
  paletteOpenButton: '打开命令面板',
  toastRemoved: '已移除「{name}」',
  toastUndo: '撤销',
  errInvalidNoManifest: 'Deck 无效：根目录缺少 deck.json。',
  errInvalidNoIndex: 'Deck 无效：根目录缺少 index.html。',
  errInvalidJson: 'Deck 无效：deck.json 不是合法的 JSON。',
  errInvalidNoName: 'Deck 无效：deck.json 缺少 "name" 字段。',
  statusHashing: '计算哈希…',
  statusUnpacking: '解压中…',
  statusReading: '读取文件…',
  statusHandoff: '交接给 Service Worker…',
  statusCaching: '缓存中…',
  statusRestoring: '从缓存恢复…',
  unregisterStatus: '正在清理 Deck 播放器数据…',
  unregisterDone: 'Deck 播放器数据已清除，可以关闭这个标签页。',
  unregisterPartial:
    '清理完成，但有部分错误（详见 console）。可以关闭这个标签页。',
}

const DICTS: Record<Lang, Dict> = { en: EN, zh: ZH }

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang
  } catch {
    // localStorage disabled (private mode etc) — fall through.
  }
  const candidates =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en']
  for (const raw of candidates) {
    const low = (raw || '').toLowerCase()
    if (low.startsWith('zh')) return 'zh'
    if (low.startsWith('en')) return 'en'
  }
  return 'en'
}

interface I18nStore {
  lang: Lang
  t: (key: DictKey, params?: Record<string, string | number>) => string
  setLang: (lang: Lang) => void
}

function format(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name]
    return v == null ? `{${name}}` : String(v)
  })
}

// Bound to the *current* dict so its identity changes on language swap —
// components selecting `s.t` re-render automatically.
function makeT(lang: Lang): I18nStore['t'] {
  const dict = DICTS[lang]
  const fallback = DICTS.en
  return (key, params) => format(dict[key] ?? fallback[key] ?? key, params)
}

export const useI18n = create<I18nStore>((set) => {
  const lang = detectLang()
  // Sync <html lang> immediately so font stacks (PingFang) take effect
  // before first paint.
  document.documentElement.setAttribute('lang', lang)
  return {
    lang,
    t: makeT(lang),
    setLang: (next: Lang) => {
      try {
        localStorage.setItem(LS_KEY, next)
      } catch {
        // Quota / disabled storage: still update in-memory state below
        // so the user's pick takes effect for this session.
      }
      document.documentElement.setAttribute('lang', next)
      set({ lang: next, t: makeT(next) })
    },
  }
})

/** Non-reactive `t()` accessor for call sites outside React render
 *  (event handlers, toasts, status messages). */
export function getT() {
  return useI18n.getState().t
}

/** Render a localized string that may contain trusted HTML — matches
 *  the vanilla `el.innerHTML = val` behavior. The dictionary is
 *  app-controlled, so dangerouslySetInnerHTML is safe here. Use this
 *  only for keys whose value is HTML (most are plain text). */
export function asHtml(html: string) {
  return { __html: html }
}
