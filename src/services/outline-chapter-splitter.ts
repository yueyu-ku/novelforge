/**
 * Vela 大纲自动拆章器 — AI 分析大纲自动建议章节数和分卷
 *
 * 输入：核心大纲 800 字
 * 输出：建议章节数 + 分卷结构 + 每卷事件密度分析
 */

import { useLLMStore } from '../stores/llm-store'

export interface ChapterSplitSuggestion {
  /** 建议总章数 */
  totalChapters: number
  /** 建议每章字数 */
  wordsPerChapter: number
  /** 分卷结构 */
  volumes: VolumePlan[]
  /** 节奏拐点（高潮章号列表） */
  climaxChapters: number[]
  /** 分析说明 */
  rationale: string
}

export interface VolumePlan {
  name: string
  chapters: [number, number]  // [start, end]
  description: string
  arcType: 'setup' | 'development' | 'twist' | 'climax' | 'resolution'
}

/**
 * AI 分析大纲，自动建议章节拆分方案
 */
export async function analyzeOutlineForChapters(
  outline: string,
  genre: string,
): Promise<ChapterSplitSuggestion | null> {
  const llmStore = useLLMStore.getState()
  const modelId = llmStore.getModelForPurpose('config_gen')
  if (!modelId) return null

  const prompt = [
    '你是一位资深的网文编辑/策划。请分析以下小说大纲，给出最合理的章节拆分建议。',
    '',
    `小说类型: ${genre}`,
    '',
    `【大纲内容】${outline}`,
    '',
    '请输出 Markdown 表格格式的分析结果：',
    '',
    '| totalChapters | wordsPerChapter | volumes | climaxChapters | rationale |',
    '|--------------|----------------|---------|----------------|-----------|',
    '| 64 | 3000 | 卷一(1-18):觉醒篇-主角获得金手指/初次打脸; 卷二(19-35):成长篇-学院竞争/首次大危机; 卷三(36-52):转折篇-真相揭露/阵营抉择; 卷四(53-64):决战篇-终极对决/结局 | 18,35,52,64 | 基于大纲的事件密度和节奏拐点分析，64章分为4卷... |',
    '',
    'volumes 格式: "卷名(起-止):描述; 卷名(起-止):描述"',
    'climaxChapters 格式: "章号,章号,章号"（高潮所在章号）',
  ].join('\n')

  try {
    const response = await llmStore.generate(
      [
        { role: 'system', content: '你是网文策划专家。只输出 Markdown 表格，不要其他文字。' },
        { role: 'user', content: prompt },
      ],
      modelId,
      { priority: 5 },
    )

    if (!response.success || !response.content) return null

    // 解析 Markdown 表格
    const { parseMarkdownTable } = await import('./workflows/workflow-utils')
    const rows = parseMarkdownTable(response.content)
    if (!rows || rows.length === 0) return null

    const row = rows[0]
    const totalChapters = parseInt(row.totalChapters) || 64
    const wordsPerChapter = parseInt(row.wordsPerChapter) || 3000

    // 解析分卷
    const volumes: VolumePlan[] = []
    const volParts = (row.volumes || '').split(';').filter(Boolean)
    const arcTypes: VolumePlan['arcType'][] = ['setup', 'development', 'twist', 'climax', 'resolution']
    for (let i = 0; i < volParts.length; i++) {
      const match = volParts[i].match(/(.+?)\((\d+)-(\d+)\)[:：](.+)/)
      if (match) {
        volumes.push({
          name: match[1].trim(),
          chapters: [parseInt(match[2]), parseInt(match[3])],
          description: match[4].trim(),
          arcType: arcTypes[i] || 'development',
        })
      }
    }

    const climaxChapters = (row.climaxChapters || '')
      .split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n))

    return {
      totalChapters,
      wordsPerChapter,
      volumes,
      climaxChapters,
      rationale: row.rationale || 'AI 基于大纲自动分析',
    }
  } catch {
    return null
  }
}
