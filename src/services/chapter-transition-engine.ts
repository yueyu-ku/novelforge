/**
 * Vela 章节过渡引擎 — 解决章节间连贯性断裂
 *
 * 每章写稿前自动提取前几章的「场景卡片」，
 * 注入 prompt 确保 AI 理解当前故事状态。
 */

import { ipc } from './ipc-client'

// ===== 类型定义 =====

export interface SceneCard {
  chapterNumber: number
  /** 本章结尾地点 */
  location: string
  /** 时间线（相对/绝对） */
  timeline: string
  /** 情绪基调 */
  mood: string
  /** 在场角色及状态 */
  charactersPresent: string[]
  /** 未解决的冲突/悬念 */
  unresolvedConflicts: string[]
  /** 关键物品状态 */
  keyItems: string
  /** 最后一段原文（200字） */
  lastParagraph: string
}

export interface TransitionContext {
  /** 最近 3 章的场景卡片 */
  recentScenes: SceneCard[]
  /** 待回收的伏笔 */
  pendingForeshadowing: string[]
  /** 过渡指导 */
  transitionGuidance: string
}

// ===== 核心函数 =====

/**
 * 从章节草稿内容中提取场景卡片
 */
export function extractSceneCard(
  chapterContent: string,
  chapterNumber: number,
): SceneCard {
  // 提取最后 500 字分析结尾状态
  const ending = chapterContent.slice(-500)

  const location = extractLocation(ending)
  const timeline = extractTimeline(ending)
  const mood = extractMood(ending)
  const charactersPresent = extractCharactersPresent(chapterContent)
  const unresolvedConflicts = extractUnresolvedConflicts(ending)
  const keyItems = extractKeyItems(chapterContent)
  const lastParagraph = chapterContent.slice(-200).trim()

  return {
    chapterNumber,
    location,
    timeline,
    mood,
    charactersPresent,
    unresolvedConflicts,
    keyItems,
    lastParagraph,
  }
}

/**
 * 为当前章节构建过渡上下文（提取前 3 章的场景卡）
 */
export async function buildTransitionContext(
  currentChapter: number,
): Promise<TransitionContext> {
  const recentScenes: SceneCard[] = []

  // 加载前 3 章的草稿
  for (let ch = Math.max(1, currentChapter - 3); ch < currentChapter; ch++) {
    try {
      const latestDraft = await ipc.invoke('db:draft-get-latest', ch)
      if (latestDraft) {
        const full = await ipc.invoke('db:draft-get-full', latestDraft.id)
        if (full?.content) {
          recentScenes.push(extractSceneCard(full.content, ch))
        }
      }
    } catch {
      // 某章无草稿则跳过
    }
  }

  // 加载未回收伏笔
  const pendingForeshadowing = await loadPendingForeshadowing(currentChapter)

  // 生成过渡指导
  const transitionGuidance = buildTransitionGuidance(recentScenes)

  return { recentScenes, pendingForeshadowing, transitionGuidance }
}

/**
 * 将过渡上下文格式化为 prompt 注入文本
 */
export function formatTransitionForPrompt(ctx: TransitionContext): string {
  if (ctx.recentScenes.length === 0) return ''

  const parts = ['## 章节过渡上下文（前情提要）']

  for (const scene of ctx.recentScenes) {
    parts.push(
      `### 第${scene.chapterNumber}章结尾状态\n` +
      `- 📍 地点: ${scene.location}\n` +
      `- 🕐 时间: ${scene.timeline}\n` +
      `- 🎭 情绪: ${scene.mood}\n` +
      `- 👥 在场: ${scene.charactersPresent.join('、') || '未知'}\n` +
      `- ⚔️ 未解决: ${scene.unresolvedConflicts.join('；') || '无'}\n` +
      `- 🎒 关键物品: ${scene.keyItems || '无'}\n` +
      `- 📝 结尾原文: "${scene.lastParagraph.slice(0, 150)}${scene.lastParagraph.length > 150 ? '…' : ''}"`,
    )
  }

  if (ctx.pendingForeshadowing.length > 0) {
    parts.push(
      `\n### ⚠️ 待回收伏笔\n${ctx.pendingForeshadowing.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
    )
  }

  if (ctx.transitionGuidance) {
    parts.push(`\n### 🎯 过渡指导\n${ctx.transitionGuidance}`)
  }

  return parts.join('\n')
}

// ===== 内部解析函数 =====

function extractLocation(text: string): string {
  // 匹配地点关键词
  const patterns = [
    /(?:在|位于|来到|回到|进入|走出)([^，。；]{2,20})(?:，|。|；|$)/g,
    /(?:殿|堂|阁|楼|院|城|镇|村|山|谷|林|洞|府|塔|宫|室|厅|房)([^，。]{0,6})/g,
  ]
  const locations: string[] = []
  for (const pattern of patterns) {
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const loc = m[1]?.trim()
      if (loc && loc.length >= 2) locations.push(loc)
    }
  }
  // 取最后一个出现的地点（结尾位置）
  return locations.length > 0 ? locations[locations.length - 1] : '未知'
}

function extractTimeline(text: string): string {
  const timePatterns = [
    /(?:第[一二三四五六七八九十\d]+天)/,
    /(?:次日|当晚|清晨|黄昏|深夜|午后|黎明|傍晚|午夜)/,
    /(?:一个时辰|半天|数日|数月)/,
    /(?:春|夏|秋|冬)(?:季|日|夜)/,
    /(?:突破|修炼|战斗)持续了/,
  ]
  for (const p of timePatterns) {
    const m = text.match(p)
    if (m) return m[0]
  }
  return '时间未明确'
}

function extractMood(text: string): string {
  const moodKeywords: Record<string, RegExp> = {
    '紧张': /紧张|危急|危险|生死|命悬|惊险/,
    '悲壮': /悲[壮伤痛哀]|牺牲|泪水|诀别|永别/,
    '热血': /热[血泪]|激昂|沸腾|燃烧|怒吼|冲[啊杀]/,
    '平静': /平静|宁静|安[详逸静]|休息|日常/,
    '悬疑': /疑惑|不解|诡异|奇怪|神秘|秘密|真相/,
    '欢快': /笑[了出声]|欢乐|愉快|开心|欣喜/,
    '愤怒': /愤[怒恨]|怒火|暴怒|杀意|仇/,
  }
  for (const [mood, pattern] of Object.entries(moodKeywords)) {
    if (pattern.test(text)) return mood
  }
  return '中性'
}

function extractCharactersPresent(content: string): string[] {
  // 提取全文中出现频率最高的角色名（基于"说/道"对话标记）
  const dialogueRegex = /([^\s]{2,4})(?:说|道|问|喊|叫|叹|怒|笑|哭)/g
  const freq = new Map<string, number>()
  let m: RegExpExecArray | null
  while ((m = dialogueRegex.exec(content)) !== null) {
    const name = m[1]
    if (name.length >= 2) freq.set(name, (freq.get(name) || 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n]) => n)
}

function extractUnresolvedConflicts(text: string): string[] {
  const conflicts: string[] = []
  const patterns = [
    /(?:还[没未不没有]|尚未|暂未)([^。；！]{4,30})/g,
    /(?:危机|危险|威胁|敌人|对手)([^。；！]{3,20})(?:仍|还|尚)/g,
    /(?:悬念|伏笔|疑问)(?::|：)?([^。；！]{4,30})/g,
    /(?:等待|期待|悬念).{0,5}(?:揭晓|解答|后续|发展)/g,
  ]
  for (const p of patterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(text)) !== null) {
      const c = (m[1] || m[0]).trim()
      if (c.length >= 3) conflicts.push(c)
    }
  }
  return conflicts.slice(0, 3)
}

function extractKeyItems(content: string): string {
  const patterns = [
    /(?:戒指|剑|刀|枪|弓|丹药|秘籍|法宝|灵器|神器|储物|令牌|地图|钥匙|玉简|卷轴)/g,
    /(?:持有|携带|获得|捡到|发现|炼化)(?:了)?(?:一[枚把柄张颗粒瓶份] )?([^，。；]{2,10})/g,
  ]
  const items: string[] = []
  for (const p of patterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(content)) !== null) {
      const item = (m[1] || m[0]).trim()
      if (item && !items.includes(item)) items.push(item)
    }
  }
  return items.slice(0, 5).join('、')
}

function buildTransitionGuidance(scenes: SceneCard[]): string {
  if (scenes.length === 0) return ''
  const last = scenes[scenes.length - 1]
  const parts: string[] = []

  parts.push(`本章开头应承接第${last.chapterNumber}章结尾: 地点"${last.location}"、情绪"${last.mood}"`)

  if (last.unresolvedConflicts.length > 0) {
    parts.push(`必须处理未解决冲突: ${last.unresolvedConflicts.join('；')}`)
  }
  if (scenes.length >= 2) {
    const prev = scenes[scenes.length - 2]
    if (prev.mood !== last.mood) {
      parts.push(`情绪从第${prev.chapterNumber}章的「${prev.mood}」过渡到第${last.chapterNumber}章的「${last.mood}」，本章继续发展`)
    }
  }

  return parts.join('。\n') + '。'
}

// ===== 伏笔加载 =====

async function loadPendingForeshadowing(
  _currentChapter: number,
): Promise<string[]> {
  try {
    // 从项目配置中读取伏笔列表
    const core = await ipc.invoke('db:project-core-get')
    if (core?.characterStates) {
      try {
        const parsed = JSON.parse(core.characterStates)
        if (parsed.pendingForeshadowing && Array.isArray(parsed.pendingForeshadowing)) {
          return parsed.pendingForeshadowing
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return []
}
