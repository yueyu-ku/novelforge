/**
 * Vela 伏笔管理器 — 追踪全书伏笔的设置与回收
 *
 * 每章定稿后自动扫描：
 * 1. 本章新增的伏笔（新物品/新人物/新谜团/预言）
 * 2. 可回收的旧伏笔（匹配章节中的回收事件）
 *
 * 写稿时注入待回收伏笔列表，确保 AI 不会遗忘。
 */

import { ipc } from './ipc-client'

// ===== 类型定义 =====

export interface ForeshadowingItem {
  id: string
  /** 伏笔内容 */
  content: string
  /** 设置章节 */
  setChapter: number
  /** 回收章节（0 = 未回收） */
  resolvedChapter: number
  /** 类型 */
  type: 'item' | 'character' | 'mystery' | 'prophecy' | 'conflict'
  /** 是否已回收 */
  resolved: boolean
  /** 创建时间 */
  createdAt: string
}

export interface ForeshadowingReport {
  /** 全部伏笔 */
  all: ForeshadowingItem[]
  /** 待回收 */
  pending: ForeshadowingItem[]
  /** 本章新增 */
  newInChapter: ForeshadowingItem[]
  /** 本章回收 */
  resolvedInChapter: ForeshadowingItem[]
}

// ===== 核心函数 =====

/**
 * 扫描章节内容，提取新增伏笔
 */
export function scanNewForeshadowing(
  content: string,
  chapterNumber: number,
): ForeshadowingItem[] {
  const items: ForeshadowingItem[] = []

  // 检测"神秘物品"类伏笔
  const itemPatterns = [
    /(?:发现|捡到|获得|得到|继承|传承)(?:了)?(?:一[枚把柄张颗粒瓶份] )?([^，。；]{3,20}(?:戒指|剑|刀|枪|丹[药丸]|秘籍|功法|法宝|灵器|神器|令牌|地图|钥匙|玉简|卷轴|遗物|宝[物藏箱]))/g,
    /([^，。；]{2,10}(?:戒指|剑|刀|枪|丹药|秘籍|法宝))(?:(?:发[光亮]|震动|共鸣|异[变动]|显[灵圣]))/g,
  ]
  for (const p of itemPatterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(content)) !== null) {
      items.push({
        id: `fs_${chapterNumber}_${items.length}_${Date.now()}`,
        content: `第${chapterNumber}章: ${m[0].trim()}`,
        setChapter: chapterNumber,
        resolvedChapter: 0,
        type: 'item',
        resolved: false,
        createdAt: new Date().toISOString(),
      })
    }
  }

  // 检测"谜团/悬念"类伏笔
  const mysteryPatterns = [
    /(?:究竟|到底)([^？?]{5,30})(?:？|\?)/g,
    /(?:谜[团题]|秘密|真相|来历不明|身世)([^。；！]{3,20})/g,
  ]
  for (const p of mysteryPatterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(content)) !== null) {
      items.push({
        id: `fs_${chapterNumber}_${items.length}_${Date.now()}`,
        content: `第${chapterNumber}章: ${m[0].trim()}`,
        setChapter: chapterNumber,
        resolvedChapter: 0,
        type: 'mystery',
        resolved: false,
        createdAt: new Date().toISOString(),
      })
    }
  }

  // 检测"预言/预示"类伏笔
  const prophecyPattern = /(?:预言|预示|未来|终将|注定|必将|命运)([^。；！]{4,30})/g
  let m2: RegExpExecArray | null
  while ((m2 = prophecyPattern.exec(content)) !== null) {
    items.push({
      id: `fs_${chapterNumber}_${items.length}_${Date.now()}`,
      content: `第${chapterNumber}章: ${m2[0].trim()}`,
      setChapter: chapterNumber,
      resolvedChapter: 0,
      type: 'prophecy',
      resolved: false,
      createdAt: new Date().toISOString(),
    })
  }

  return items.slice(0, 5) // 每章最多 5 个新伏笔
}

/**
 * 检测本章是否回收了旧伏笔
 */
export function detectResolvedForeshadowing(
  content: string,
  pendingItems: ForeshadowingItem[],
  chapterNumber: number,
): ForeshadowingItem[] {
  const resolved: ForeshadowingItem[] = []

  for (const item of pendingItems) {
    // 提取伏笔关键词进行匹配
    const keywords = item.content.replace(/第\d+章[:：]\s*/, '').slice(0, 20)
    const keywordParts = keywords.split(/[，。；！？\s]+/).filter(k => k.length >= 2)

    let matchCount = 0
    for (const kw of keywordParts) {
      if (content.includes(kw)) matchCount++
    }

    // 如果 60% 以上关键词出现在本章，视为已回收
    if (keywordParts.length > 0 && matchCount / keywordParts.length >= 0.6) {
      resolved.push({ ...item, resolvedChapter: chapterNumber, resolved: true })
    }
  }

  return resolved
}

/**
 * 保存伏笔列表到项目配置
 */
export async function saveForeshadowing(items: ForeshadowingItem[]): Promise<void> {
  try {
    const core = await ipc.invoke('db:project-core-get')
    if (core) {
      let states: Record<string, unknown> = {}
      try { states = JSON.parse(core.characterStates || '{}') } catch { /* ignore */ }
      states.pendingForeshadowing = items.filter(i => !i.resolved).map(i => i.content)
      await ipc.invoke('db:project-core-update', { characterStates: JSON.stringify(states) })
    }
  } catch { /* ignore */ }
}

/**
 * 加载全部伏笔
 */
export async function loadAllForeshadowing(): Promise<ForeshadowingItem[]> {
  try {
    const core = await ipc.invoke('db:project-core-get')
    if (core?.characterStates) {
      const states = JSON.parse(core.characterStates)
      if (states.foreshadowingAll) return states.foreshadowingAll
    }
  } catch { /* ignore */ }
  return []
}

/**
 * 格式化待回收伏笔列表（用于 prompt 注入）
 */
export function formatPendingForPrompt(items: ForeshadowingItem[]): string {
  const pending = items.filter(i => !i.resolved)
  if (pending.length === 0) return ''
  return pending.map((f, i) => `${i + 1}. [第${f.setChapter}章] ${f.content} (${f.type})`).join('\n')
}
