import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags, extractAndRepairJSON, parseMarkdownTable } from './workflow-utils'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

const EMPTY_BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 0,
  title: '',
  role: '发展',
  purpose: '',
  keyEvents: '',
  characters: [],
  suspenseHook: '',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

// ==========================================
// 2. 蓝图解析与文件访问
// ==========================================

/**
 * 从已解析的 JSON 数据中提取蓝图数组并转换为 ChapterBlueprint[]
 * 供 parseTextBlueprints 的 JSON fallback 路径使用
 */
export function parseTextBlueprintsFromParsed(
  parsed: unknown,
  startNum: number,
  endNum: number,
): ChapterBlueprint[] {
  const result: ChapterBlueprint[] = []

  // 辅助：获取章节号
  const getChapterNum = (p: Record<string, unknown>): number => {
    const n = Number(p.chapterNumber ?? p.chapter_number ?? p.chapter ?? p.number ?? p.chapterNum ?? p.id ?? 0)
    return isNaN(n) ? 0 : n
  }

  // 辅助：从对象中提取蓝图数组
  const extractArrayFromObject = (obj: Record<string, unknown>): unknown[] | null => {
    for (const key of ['blueprints', 'chapters', 'chapterBlueprints', 'data', 'results', 'list']) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[]
      }
    }
    for (const val of Object.values(obj)) {
      if (Array.isArray(val) && val.length > 0) {
        return val as unknown[]
      }
    }
    return null
  }

  // 统一提取蓝图数组（支持多种 wrapper key 和嵌套结构）
  let blueprintArray: unknown[] | null = null

  if (Array.isArray(parsed)) {
    const firstItem = parsed[0]
    if (firstItem && typeof firstItem === 'object' && !Array.isArray(firstItem)) {
      const obj = firstItem as Record<string, unknown>
      if (getChapterNum(obj) > 0) {
        blueprintArray = parsed
      } else {
        const allChapters: unknown[] = []
        for (const item of parsed) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const arr = extractArrayFromObject(item as Record<string, unknown>)
            if (arr) allChapters.push(...arr)
          }
        }
        blueprintArray = allChapters.length > 0 ? allChapters : parsed
      }
    } else {
      blueprintArray = parsed
    }
  } else if (parsed && typeof parsed === 'object') {
    blueprintArray = extractArrayFromObject(parsed as Record<string, unknown>)
  }

  if (!blueprintArray || blueprintArray.length === 0) {
    return []
  }

  for (const item of blueprintArray) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const chNum = getChapterNum(p)

    if (chNum <= 0) continue
    if (chNum < startNum || chNum > endNum) continue

    const chars = p.characters ?? p.characterList ?? p.character_list ?? []
    // 容错：AI 可能返回字符串 "角色A, 角色B" 而非数组
    let characterArray: string[]
    if (Array.isArray(chars)) {
      characterArray = chars.map(String)
    } else if (typeof chars === 'string' && chars.trim().length > 0) {
      characterArray = chars.split(/[,，、\s]+/).filter(Boolean)
    } else {
      characterArray = []
    }
    result.push({
      ...EMPTY_BLUEPRINT,
      chapterNumber: chNum,
      title: String(p.title ?? p.chapterTitle ?? p.chapter_title ?? `第${chNum}章`),
      role: String(p.role ?? '发展'),
      purpose: String(p.purpose ?? p.goal ?? ''),
      keyEvents: String(p.keyEvents ?? p.key_events ?? p.events ?? ''),
      characters: characterArray,
      suspenseHook: String(p.suspenseHook ?? p.suspense_hook ?? p.hook ?? ''),
      userGuidance: '',
    })
  }

  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) distinctMap.set(item.chapterNumber, item)
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/**
 * 从 Markdown 表格解析结果转换为 ChapterBlueprint[]
 * 与 parseTextBlueprintsFromParsed 逻辑对等，但输入是 table row 而非 JSON
 */
export function parseTextBlueprintsFromTable(
  rows: Array<Record<string, string>>,
  startNum: number,
  endNum: number,
): ChapterBlueprint[] {
  const result: ChapterBlueprint[] = []

  for (const row of rows) {
    const chNum = Number(row.chapterNumber)
    if (isNaN(chNum) || chNum <= 0) continue
    if (chNum < startNum || chNum > endNum) continue

    // 解析角色列表：支持逗号、中文逗号、顿号分隔
    const charStr = row.characters || ''
    const characterArray = charStr
      .split(/[,，、\s]+/)
      .map(s => s.trim())
      .filter(Boolean)

    result.push({
      ...EMPTY_BLUEPRINT,
      chapterNumber: chNum,
      title: row.title || `第${chNum}章`,
      role: row.role || '发展',
      purpose: row.purpose || '',
      keyEvents: row.keyEvents || '',
      characters: characterArray,
      suspenseHook: row.suspenseHook || '',
      userGuidance: '',
    })
  }

  // 去重：同一章节号只保留第一条
  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) {
      distinctMap.set(item.chapterNumber, item)
    }
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/**
 * 解析 AI 输出的蓝图文本（双路径策略）
 *
 * PATH 1: Markdown 表格（主路径）— 更可靠
 * PATH 2: JSON（fallback 路径）— 向后兼容
 */
export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  try {
    const cleanContent = stripThinkingTags(content)

    // ==== PATH 1: Markdown 表格（主路径）====
    const tableRows = parseMarkdownTable(cleanContent)
    if (tableRows && tableRows.length > 0) {
      const result = parseTextBlueprintsFromTable(tableRows, startNum, endNum)
      if (result.length > 0) {
        console.log(`[parseTextBlueprints] Markdown 表格解析成功: ${result.length} 章蓝图`)
        return result
      }
    }

    // ==== PATH 2: JSON（fallback 路径）====
    console.log('[parseTextBlueprints] Markdown 表格未产生结果，回落 JSON 解析...')

    // 预处理：移除 AI 常见的前导/后随说明文本
    let jsonContent = cleanContent
    const firstBrace = jsonContent.indexOf('{')
    const firstBracket = jsonContent.indexOf('[')
    const lastBrace = jsonContent.lastIndexOf('}')
    const lastBracket = jsonContent.lastIndexOf(']')
    const start = firstBrace !== -1 ? firstBrace : firstBracket
    const end = lastBrace !== -1 ? lastBrace : lastBracket
    if (start !== -1 && end !== -1 && end > start) {
      jsonContent = jsonContent.substring(start, end + 1)
    }

    // 多层级提取 + 修复引擎
    let { parsed, repaired } = extractAndRepairJSON(jsonContent, false)
    if (!parsed) {
      const arrayResult = extractAndRepairJSON(jsonContent, true)
      parsed = arrayResult.parsed
      repaired = repaired || arrayResult.repaired
    }

    if (!parsed) {
      console.error('[parseTextBlueprints] JSON 解析完全失败\n原始内容前500字:', cleanContent.slice(0, 500))
      return []
    }

    if (repaired) {
      console.log('[parseTextBlueprints] JSON 经过修复后成功解析，解析到顶层类型:', Array.isArray(parsed) ? `数组(${parsed.length}项)` : `对象(${Object.keys(parsed as object).length}键)`)
    }

    const result = parseTextBlueprintsFromParsed(parsed, startNum, endNum)

    if (result.length === 0) {
      console.warn(
        `[parseTextBlueprints] 从已解析数据中未提取到有效蓝图 ` +
        `(期望章节范围 ${startNum}-${endNum})`,
        '\n解析类型:', Array.isArray(parsed) ? '数组' : typeof parsed,
        '\n解析结果:', JSON.stringify(parsed).slice(0, 500),
      )
    }

    return result
  } catch (e) {
    console.error('[parseTextBlueprints] 未预期异常:', e, '\n原始内容前500字:', content.slice(0, 500))
    return []
  }
}

export async function loadDirectoryBlueprints(): Promise<ChapterBlueprint[]> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
  } catch {
    return []
  }
}

export async function saveChapterBlueprint(blueprint: ChapterBlueprint): Promise<void> {
  const result = await ipc.invoke('db:blueprint-upsert', blueprint)
  if (!result.success) {
    throw new Error(`蓝图保存失败 (第${blueprint.chapterNumber}章): ${result.error || '未知错误'}`)
  }
}

export async function saveAllBlueprints(blueprints: ChapterBlueprint[]): Promise<void> {
  const result = await ipc.invoke('db:blueprint-upsert-many', blueprints)
  if (!result.success) {
    throw new Error(`批量蓝图保存失败: ${result.error || '未知错误'}`)
  }
}

export async function getBlueprintCount(): Promise<number> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(params: DirectoryWorkflowParams = { mode: 'full' }): WorkflowDefinition {
  return {
    type: 'directory',
    title: params.mode === 'append' ? `📋 续写章节蓝图${params.startChapter ? `（从第 ${params.startChapter} 章）` : ''}` : '📋 生成章节蓝图（全量）',
    steps: [
      {
        name: '读取架构',
        description: `从 SQLite 加载项目架构信息`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          callbacks.log('读取项目架构信息...')
          const core = await ipc.invoke('db:project-core-get')
          if (!core) throw new Error('项目核心数据未初始化')

          const parts: string[] = []
          if (core.premise && core.premise.length > 50) parts.push(core.premise)
          if (core.charactersArch && core.charactersArch.length > 50) parts.push(core.charactersArch)
          if (core.worldbuilding && core.worldbuilding.length > 50) parts.push(core.worldbuilding)
          if (core.synopsis && core.synopsis.length > 50) parts.push(core.synopsis)

          if (parts.length === 0) throw new Error('项目主要架构均未生成')

          context.data.architecture = parts.join('\n\n---\n\n')
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints()
            context.data.existingBlueprints = existing
            callbacks.log(`已加载 ${existing.length} 章已有蓝图`)
          }
          return `架构加载完成（${parts.length} 段）`
        },
      },
      {
        name: '生成蓝图',
        description: '基于架构文件生成全书章节蓝图',
        executor: async (_step, context, callbacks) => {
          const { GenerateDirectoryCommand } = await import('./commands/directory.command')
          const cmd = new GenerateDirectoryCommand(params)
          const blueprints = await cmd.execute({ step: _step, context, callbacks })
          return `已生成 ${blueprints.length} 章蓝图`
        },
      },
      {
        name: '保存蓝图',
        description: `将章节蓝图批量写入 SQLite 数据库`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          const newBlueprints = context.data.newBlueprints as ChapterBlueprint[]
          const existingBlueprints = context.data.existingBlueprints as ChapterBlueprint[]

          callbacks.log('保存蓝图到数据库...')

          let merged: ChapterBlueprint[]
          if (params.mode === 'full') {
            merged = newBlueprints
            // 全量模式：删除不在新列表中的旧蓝图
            const newChapterNums = new Set(newBlueprints.map(b => b.chapterNumber))
            const allExisting = await loadDirectoryBlueprints()
            const coverageRatio = allExisting.length > 0
              ? newBlueprints.length / Math.max(allExisting.length, newBlueprints.length)
              : 1

            if (coverageRatio >= 0.5 || newBlueprints.length >= project.novelConfig.totalChapters * 0.8) {
              for (const existing of allExisting) {
                if (!newChapterNums.has(existing.chapterNumber)) {
                  try {
                    await ipc.invoke('db:blueprint-delete', existing.chapterNumber)
                  } catch {
                    callbacks.log(`  ⚠️ 第 ${existing.chapterNumber} 章旧蓝图保留（有关联草稿）`)
                  }
                }
              }
            } else {
              callbacks.log(`  ⚠️ 新蓝图仅覆盖 ${(coverageRatio * 100).toFixed(0)}% 章节（${newBlueprints.length}/${allExisting.length}），保留全部旧蓝图防止数据丢失`)
            }
          } else {
            const existingMap = new Map(existingBlueprints.map(b => [b.chapterNumber, b]))
            for (const nb of newBlueprints) existingMap.set(nb.chapterNumber, nb)
            merged = Array.from(existingMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
          }

          await saveAllBlueprints(merged)
          useProjectStore.getState().refreshFileTree()
          return '已保存蓝图'
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append' ? '✅ 续写蓝图生成完成' : '✅ 全书章节蓝图已生成完成！',
    },
  }
}
