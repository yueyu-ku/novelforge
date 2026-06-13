import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { getPromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  stripThinkingTags,
  type PostProcessStep,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import type { StepCallbacks } from '../../../stores/workflow-store'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
}

// ===== 工具函数：流式调用大模型并返回完整文本 =====

/**
 * 使用 PromptBuilder 调用 LLM（不依赖 BaseWorkflowCommand 实例）
 * 独立函数，可被 PostProcessStep 的 executor 直接调用
 */
async function callLLMForPostProcess(
  builder: { build: () => string; getSystemRole: () => string },
  callbacks: { appendText: (text: string) => void },
  options?: { responseFormat?: { type: string } },
): Promise<string> {
  const llmStore = useLLMStore.getState()
  if (!llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

  const modelId = llmStore.defaultModelId
  const model = llmStore.models.find(m => m.id === modelId)
  const startTime = Date.now()

  const logLLMCall = (success: boolean, errorMessage?: string) => {
    const duration = Date.now() - startTime
    ipc.invoke('db:log-llm-call', {
      model_id: modelId,
      model_name: model?.name ?? model?.modelName ?? '',
      purpose: 'post_process',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      duration_ms: duration,
      success: success ? 1 : 0,
      error_message: errorMessage ?? '',
    }).catch(() => { })
  }

  return new Promise<string>((resolve, reject) => {
    let fullContent = ''
    llmStore.generateStream(
      [
        { role: 'system', content: builder.getSystemRole() },
        { role: 'user', content: builder.build() },
      ],
      {
        onChunk: (chunk) => { fullContent += chunk; callbacks.appendText(chunk) },
        onDone: (text, usage) => {
          if (usage) {
            ipc.invoke('db:log-llm-call', {
              model_id: modelId,
              model_name: model?.name ?? model?.modelName ?? '',
              purpose: 'post_process',
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
              duration_ms: Date.now() - startTime,
              success: 1,
            }).catch(() => { })
          } else {
            logLLMCall(true)
          }
          const raw = text || fullContent
          resolve(stripThinkingTags(raw))
        },
        onError: (err) => {
          logLLMCall(false, err || '流式生成失败')
          reject(new Error(err || '流式生成失败'))
        },
      },
      undefined,
      options,
    )
  })
}


// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: '📚 导入知识库',
    critical: true,
    executor: async (callbacks) => {
      const contentFileName = chapterTitle
        ? `第${chapterNumber}章 ${chapterTitle}.txt`
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invoke('kb:import-text', draftContent, contentFileName, _project.path) as { success: boolean; error?: string; chunkCount?: number }
      if (result.success) {
        callbacks.log(`✅ 正文章节已导入知识库（${result.chunkCount} 块）`)
      } else {
        throw new Error(`导入知识库失败: ${result.error}`)
      }
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  const notesTemplate = getPromptTemplate('generate_chapter_notes')
  if (notesTemplate) {
    steps.push({
      key: 'chapter_notes',
      label: '📋 章节剧情要点',
      critical: true,
      executor: async (callbacks) => {
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        const cleanNotes = await callLLMForPostProcess(notesBuilder, callbacks)

        // 写入蓝图 JSON 的 notes 字段
        await ipc.invoke('db:blueprint-update-notes', chapterNumber, cleanNotes)
        callbacks.log('✅ 本章剧情要点提取完成（已写入蓝图）')
      },
    })
  }

  // ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  const cardTemplate = getPromptTemplate('update_character_cards')
  if (cardTemplate) {
    steps.push({
      key: 'character_cards',
      label: '🎭 角色状态更新',
      critical: false,
      executor: async (callbacks) => {
        // 读取现有角色卡
        const allChars = (await ipc.invoke('db:character-get-all')) as unknown as Array<Record<string, unknown>>
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        const cardBuilder = new PostProcessPromptBuilder(cardTemplate)
          .withChapterContent(draftContent.slice(0, 5000))
          .withChapterNumber(chapterNumber)
          .withExistingCardsJson(simpleCards)

        const cardsResult = await callLLMForPostProcess(cardBuilder, callbacks)

        // 解析 Markdown 表格格式的角色状态更新（比 JSON 更稳定）
        const { parseMarkdownTable } = await import('../workflow-utils')
        const updSections = cardsResult.split(/###\s*(UPDATES|NEW)/i)
        let updateRows: Array<Record<string, string>> = []
        let newRows: Array<Record<string, string>> = []

        for (let si = 0; si < updSections.length; si++) {
          const label = updSections[si]?.trim().toUpperCase()
          const content = updSections[si + 1] || ''
          if (label === 'UPDATES') {
            updateRows = parseMarkdownTable(content) || []
          } else if (label === 'NEW') {
            newRows = parseMarkdownTable(content) || []
          }
        }
        // 如果没有分段，尝试整体解析
        if (updateRows.length === 0 && newRows.length === 0) {
          updateRows = parseMarkdownTable(cardsResult) || []
        }

        if (updateRows.length > 0) {
          for (const row of updateRows) {
            const name = row.name || ''
            if (!name) continue
            const dbChar = allChars.find((c) => c.name === name)
            if (dbChar) {
              const dbCharState = (dbChar.currentState as Record<string, unknown>) || {}
              const newState = {
                location: row.location || (dbCharState.location as string) || '',
                powerLevel: row.powerLevel || (dbCharState.powerLevel as string) || '',
                physicalState: row.physicalState || (dbCharState.physicalState as string) || '',
                mentalState: row.mentalState || (dbCharState.mentalState as string) || '',
                keyItems: row.keyItems || (dbCharState.keyItems as string) || '',
                recentEvents: row.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
              await ipc.invoke('db:character-update-state', name, newState)
              callbacks.log(`更新角色状态: ${name}`)
            }
          }
        }

        if (newRows.length > 0) {
          let newCharCount = 0
          for (const row of newRows) {
            const name = row.name || ''
            if (!name || allChars.some((c) => c.name === name)) continue
            newCharCount++
            await ipc.invoke('db:character-upsert', {
              name: name,
              role: row.role || 'supporting',
              gender: '', age: '', appearance: '', personality: '', background: '',
              abilities: '', motivation: '', relationships: '', arc: '', notes: '',
              currentState: {
                location: row.location || '',
                powerLevel: row.powerLevel || '',
                physicalState: row.physicalState || '',
                mentalState: row.mentalState || '',
                keyItems: row.keyItems || '',
                recentEvents: row.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
            })
          }
          if (newCharCount > 0) {
            callbacks.log(`✅ 自动提取并登记 ${newCharCount} 名新出场角色`)
          }
        }
      },
    })
  }

  // ─── 步骤 4: 文风自动学习（每5章触发一次）─────────────────────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'style_analysis',
      label: '🎨 文风自动学习',
      critical: false,
      executor: async (callbacks) => {
        callbacks.log('🎨 触发文风自动学习（每5章一次）...')
        const { AnalyzeWritingStyleCommand } = await import('./analyze-style.command')
        await new AnalyzeWritingStyleCommand().execute({
          step: {} as unknown,
          context: { data: {}, cancelled: false },
          callbacks,
        })
        callbacks.log('✅ 文风分析完成，已更新配置')
      },
    })
  }

  // 步骤 3.2: 伏笔扫描
  const voiceIdx = steps.length - (chapterNumber % 5 === 0 ? 2 : 1)
  steps.splice(voiceIdx, 0, {
    key: 'foreshadowing_scan',
    label: '🔮 伏笔扫描',
    critical: false,
    executor: async (callbacks: StepCallbacks) => {
      try {
        const { scanNewForeshadowing, detectResolvedForeshadowing, loadAllForeshadowing, saveForeshadowing } = await import('../../foreshadowing-manager')
        const all = await loadAllForeshadowing()
        const news = scanNewForeshadowing(draftContent, chapterNumber)
        const done = detectResolvedForeshadowing(draftContent, all, chapterNumber)
        const merged = [...all.filter(i => !done.some(d => d.id === i.id)), ...news]
        await saveForeshadowing(merged)
        if (news.length) callbacks.log(`新增${news.length}伏笔/回收${done.length}旧伏笔`)
      } catch (e) { callbacks.log(`⚠️ 伏笔扫描失败: ${String(e)}`) }
    },
  })

  // 步骤 3.5: 角色声音分析
  steps.splice(voiceIdx + 1, 0, {
    key: 'voice_analysis',
    label: '🎤 角色声音分析',
    critical: false,
    executor: async (callbacks: StepCallbacks) => {
      callbacks.log('正在分析角色对话风格...')
      try {
        const { analyzeCharacterVoice } = await import('../../character-voice-analyzer')
        const characters = await ipc.invoke('db:character-get-all') as Array<{ name: string; notes?: string }>
        let analyzed = 0
        for (const char of characters) {
          if (!char.name) continue
          try {
            const profile = analyzeCharacterVoice(draftContent, char.name)
            if (profile.topWords.length > 0) {
              const voiceData = JSON.stringify(profile)
              const updatedNotes = (char.notes || '') + `\n[VOICE:${char.name}]\n${voiceData}\n`
              await ipc.invoke('db:character-upsert', {
                name: char.name, role: 'supporting',
                gender: '', age: '', appearance: '', personality: '', background: '',
                abilities: '', motivation: '', relationships: '', arc: '', notes: updatedNotes,
                currentState: { location: '', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: chapterNumber },
              } as never)
              analyzed++
            }
          } catch { /* skip */ }
        }
        callbacks.log(`角色声音分析完成 (${analyzed}/${characters.length})`)
      } catch (e) {
        callbacks.log(`⚠️ 角色声音分析失败: ${String(e)}`)
      }
    },
  })

  return steps
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const refinedDraftText = this.params.draftContent
    if (!refinedDraftText) throw new Error('没有定稿内容')

    callbacks.log('\n===== 开始定稿与后处理分析 =====')

    // 1. 获取对应草稿并将库内状态变更为 finalized（同时同步定稿期可能微调过的正文）
    const { parseDraftMeta } = await import('../chapter-workflow')
    const dbDraft = await parseDraftMeta(this.params.draftPath)
    if (!dbDraft) throw new Error('内部状态流转异常：无法在数据库中定位该草稿源文件或解析路径版本')

    await ipc.invoke('db:draft-update-content', dbDraft.id, refinedDraftText, refinedDraftText.length)
    await ipc.invoke('db:draft-update-status', dbDraft.id, 'finalized', refinedDraftText.length)

    // 【重要】：除了写入 DB，对于已定稿的章节需要实体化为物理文件放在根目录，供外部系统读取或备份
    const safeTitle = this.params.chapterInfo.title ? ` ${this.params.chapterInfo.title.replace(/[/\\]/g, '_')}` : ''
    const physicalPath = `${project.path}/第${this.params.chapterNumber}章${safeTitle}.txt`
    try {
      const titleLine = this.params.chapterInfo.title ? `第${this.params.chapterNumber}章 ${this.params.chapterInfo.title}\n\n` : `第${this.params.chapterNumber}章\n\n`
      const contentToWrite = titleLine + refinedDraftText.replace(/^#+ .*\n*/, '')
      await ipc.invoke('fs:write-file', physicalPath, contentToWrite)
    } catch (e) {
      callbacks.log(`⚠️ 写入根目录物理文件失败: ${String(e)}`)
    }

    callbacks.log(`✅ 定稿内容已正式写入 SQLite 数据库并同步为根目录文件 (第${this.params.chapterNumber}章${safeTitle}.txt)`)

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log('🚀 正在启动后台大模型推演系统更新全书状态...')

    const scope = getChapterFinalizeScope(this.params.chapterNumber)
    const sourceLabel = `第${this.params.chapterNumber}章定稿`
    const steps = buildFinalizePostProcessSteps(
      project,
      this.params.chapterNumber,
      this.params.chapterInfo.title,
      refinedDraftText,
    )

    await runPostProcessPipeline(project.path, scope, sourceLabel, steps, callbacks)

    callbacks.log('\n🎉 第' + this.params.chapterNumber + '章创作全流程彻底完成！')
    useProjectStore.getState().refreshFileTree()

    // 通过 EventBus 通知 ProjectService 执行定稿后的统一刷新
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', { chapterNumber: this.params.chapterNumber })
  }
}
