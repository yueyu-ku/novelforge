import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags, extractAndRepairJSON } from './workflow-utils'

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
// 2. 蓝图文件访问与工具函数
// ==========================================

/**
 * 从已解析的 JSON 数据中提取蓝图数组并转换为 ChapterBlueprint[]
 * 供 parseTextBlueprints 和 directory.command 的修复重试路径共同使用
 */
export function parseTextBlueprintsFromParsed(
  parsed: unknown,
  startNum: number,
  endNum: number,
): ChapterBlueprint[] {
  const result: ChapterBlueprint[] = []

  // 1. 统一提取蓝图数组（支持多种 wrapper key）
  let blueprintArray: unknown[] | null = null

  if (Array.isArray(parsed)) {
    blueprintArray = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['blueprints', 'chapters', 'chapterBlueprints', 'data', 'results', 'list']) {
      if (Array.isArray(obj[key])) {
        blueprintArray = obj[key] as unknown[]
        break
      }
    }
    if (!blueprintArray) {
      for (const val of Object.values(obj)) {
        if (Array.isArray(val) && val.length > 0) {
          blueprintArray = val as unknown[]
          break
        }
      }
    }
  }

  if (!blueprintArray || blueprintArray.length === 0) {
    return []
  }

  // 2. 过滤并映射蓝图数据（支持多种字段名变体）
  const getChapterNum = (p: Record<string, unknown>): number => {
    const n = Number(p.chapterNumber ?? p.chapter_number ?? p.chapter ?? p.number ?? p.chapterNum ?? p.id ?? 0)
    return isNaN(n) ? 0 : n
  }

  for (const item of blueprintArray) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const chNum = getChapterNum(p)

    if (chNum <= 0) continue
    if (chNum < startNum || chNum > endNum) continue

    const chars = p.characters ?? p.characterList ?? p.character_list ?? []
    result.push({
      ...EMPTY_BLUEPRINT,
      chapterNumber: chNum,
      title: String(p.title ?? p.chapterTitle ?? p.chapter_title ?? `第${chNum}章`),
      role: String(p.role ?? '发展'),
      purpose: String(p.purpose ?? p.goal ?? ''),
      keyEvents: String(p.keyEvents ?? p.key_events ?? p.events ?? ''),
      characters: Array.isArray(chars) ? chars.map(String) : [],
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

export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  try {
    const cleanContent = stripThinkingTags(content)

    // 多层级提取 + 修复引擎（代码块提取 → 字符清洗 → JSON修复 → 逐对象兜底）
    let { parsed, repaired } = extractAndRepairJSON(cleanContent, false)
    if (!parsed) {
      const arrayResult = extractAndRepairJSON(cleanContent, true)
      parsed = arrayResult.parsed
      repaired = repaired || arrayResult.repaired
    }

    if (!parsed) {
      console.error('[parseTextBlueprints] JSON 解析完全失败\n原始内容前500字:', content.slice(0, 500))
      return []
    }

    if (repaired) {
      console.log('[parseTextBlueprints] JSON 经过修复后成功解析')
    }

    const result = parseTextBlueprintsFromParsed(parsed, startNum, endNum)

    if (result.length === 0) {
      console.warn(
        `[parseTextBlueprints] 从已解析数据中未提取到有效蓝图 ` +
        `(期望章节范围 ${startNum}-${endNum})`,
        '\n解析结果:', JSON.stringify(parsed).slice(0, 300),
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
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
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
            // 全量模式：删除不在新列表中的旧蓝图（仅删除无关联草稿的，避免孤立数据）
            const newChapterNums = new Set(newBlueprints.map(b => b.chapterNumber))
            const allExisting = await loadDirectoryBlueprints()
            for (const existing of allExisting) {
              if (!newChapterNums.has(existing.chapterNumber)) {
                try {
                  await ipc.invoke('db:blueprint-delete', existing.chapterNumber)
                } catch {
                  // 若有关联草稿，删除会失败，保留蓝图
                  callbacks.log(`  ⚠️ 第 ${existing.chapterNumber} 章旧蓝图保留（有关联草稿）`)
                }
              }
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
