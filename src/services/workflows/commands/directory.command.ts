import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { DirectoryWorkflowParams, ChapterBlueprint, parseTextBlueprints, parseTextBlueprintsFromParsed, saveAllBlueprints } from '../directory-workflow'
import { stripThinkingTags, extractAndRepairJSON } from '../workflow-utils'

/**
 * 为 Prompt 注入清洗蓝图内容：
 * - 截断过长的 keyEvents（防止 prompt 膨胀）
 * - 转义 pipe 字符防止破坏 Markdown 表格上下文
 */
function sanitizeForPrompt(text: string, maxLen: number = 60): string {
  return text
    .replace(/\n/g, ' ')             // 换行 → 空格
    .replace(/\|/g, '/')             // pipe → slash（保护表格上下文）
    .slice(0, maxLen)                // 截断
    .trim()
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  constructor(private params: DirectoryWorkflowParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]

    const totalChapters = project.novelConfig.totalChapters
    const globalGuidance = project.novelConfig.globalGuidance || ''
    const genre = project.novelConfig.genre || ''

    let startChapter = 1
    let endChapter = totalChapters

    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || (existingBlueprints.length + 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = startChapter + this.params.count - 1
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }

    callbacks.log(`生成第 ${startChapter}–${endChapter} 章蓝图...`)

    // 从当前默认模型获取 maxTokens，动态计算每批次章节数
    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.models.find(m => m.id === llmStore.defaultModelId)
    const modelMaxTokens = defaultModel?.maxTokens || 4096
    const outputBudget = Math.floor(modelMaxTokens * 0.6)  // 预留 40% 给 prompt + 思考
    const tokensPerChapter = 200
    const batchSize = Math.min(50, Math.max(5, Math.floor(outputBudget / tokensPerChapter)))

    const newBlueprints: ChapterBlueprint[] = []
    // 使用游标追踪生成进度，支持 AI 超额返回时智能跳过后续批次
    let cursor = startChapter
    // 多级重试策略：本地修复 → 中批次(5章) → 单章
    let consecutiveParseFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5  // 增加容错次数（修复不算新 LLM 调用）
    // 动态批次大小
    let effectiveBatchSize = batchSize

    while (cursor <= endChapter) {
      if (context.cancelled) { callbacks.log('已取消'); break }

      const batchEnd = Math.min(cursor + effectiveBatchSize - 1, endChapter)
      if (effectiveBatchSize < batchSize) {
        callbacks.log(`  正在生成第 ${cursor}–${batchEnd} 章...（缩小批次重试，${effectiveBatchSize} 章/批）`)
      } else {
        callbacks.log(`  正在生成第 ${cursor}–${batchEnd} 章...`)
      }

      let prompt: string
      if (cursor === 1 && this.params.mode === 'full') {
        const template = getPromptTemplate('chapter_blueprint')
        if (!template) throw new Error('模板丢失')
        prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withNumberOfChapters(endChapter)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
      } else {
        const template = getPromptTemplate('chapter_blueprint_chunk')
        if (!template) throw new Error('模板丢失')

        // 构建上下文章节列表（清洗 + 截断，防止 prompt 膨胀）
        const prevAll = [...existingBlueprints, ...newBlueprints]
        // 最多取最近 20 章，防止超出上下文窗口
        const chapterList = prevAll.slice(-20).map(c =>
          `第${c.chapterNumber}章 ${sanitizeForPrompt(c.title, 30)}：${sanitizeForPrompt(c.keyEvents, 80)}`
        ).join('\n')
        const chapterListNote = prevAll.length > 20
          ? `（仅展示最近 20 章，共 ${prevAll.length} 章前置蓝图，更多历史不再赘述）`
          : `（共 ${prevAll.length} 章前置蓝图）`

        prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withChapterList((chapterList || '（首批生成）') + '\n' + chapterListNote)
          .withNumberOfChapters(totalChapters)
          .withN(cursor)
          .withM(batchEnd)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
      }

      callbacks.setProgress(Math.round(((cursor - startChapter) / (endChapter - startChapter + 1)) * 90))

      // systemRole 由模板定义
      const systemRole = getPromptTemplate('chapter_blueprint')?.systemRole || '你是一位经验丰富的网文架构师。'
      const resultText = await this.callLLM(prompt, systemRole, callbacks)

      // 接受 AI 返回的从 cursor 到 endChapter 范围内的所有有效章节
      // AI 可能一次性返回超出本批次（batchEnd）的章节，全部保留
      const parsed = parseTextBlueprints(resultText, cursor, endChapter)
      newBlueprints.push(...parsed)

      // 批次入库
      if (parsed.length > 0) {
        await saveAllBlueprints(parsed)
        useProjectStore.getState().refreshFileTree()
      }

      // 计算本次实际生成到的最大章节号，推进游标到已生成的最后一章之后
      if (parsed.length > 0) {
        consecutiveParseFailures = 0
        effectiveBatchSize = batchSize  // 恢复完整批次大小
        const actualMaxChapter = Math.max(...parsed.map(p => p.chapterNumber))
        const actualMinChapter = Math.min(...parsed.map(p => p.chapterNumber))

        // 缺口检测：如果游标章节在结果中缺失，下一轮重试会填补
        if (actualMinChapter > cursor) {
          callbacks.log(`  ⚠️ 第 ${cursor} 章在结果中缺失（检测到第 ${actualMinChapter}–${actualMaxChapter} 章），将在下一轮填补缺口`)
        } else {
          callbacks.log(`  ✅ 第 ${cursor}–${actualMaxChapter} 章完成（${parsed.length} 章）并已保存入库`)
          cursor = actualMaxChapter + 1
        }
      } else {
        consecutiveParseFailures++
        callbacks.log(`  ⚠️ 第 ${cursor}–${batchEnd} 章解析失败（连续 ${consecutiveParseFailures}/${MAX_CONSECUTIVE_FAILURES}）`)

        // 三级降级策略：本地修复（不消耗 Token）→ 缩小批次 → 单章兜底
        // parseTextBlueprints 内部会自动尝试 Markdown 表格 → JSON fallback 两条路径
        if (consecutiveParseFailures === 1) {
          // 第 1 次失败：尝试更深层的本地 JSON 修复
          callbacks.log(`  🔧 尝试本地修复 JSON（不消耗额外 Token）...`)
          const repairResult = extractAndRepairJSON(stripThinkingTags(resultText), false)
          if (repairResult.parsed) {
            callbacks.log(`  ✅ 本地修复成功，提取到有效数据`)
            const repairedBlueprints = parseTextBlueprintsFromParsed(repairResult.parsed, cursor, endChapter)
            if (repairedBlueprints.length > 0) {
              newBlueprints.push(...repairedBlueprints)
              await saveAllBlueprints(repairedBlueprints)
              useProjectStore.getState().refreshFileTree()
              consecutiveParseFailures = 0
              effectiveBatchSize = batchSize
              const actualMaxChapter = Math.max(...repairedBlueprints.map(p => p.chapterNumber))
              callbacks.log(`  ✅ 第 ${cursor}–${actualMaxChapter} 章完成（修复后 ${repairedBlueprints.length} 章）并已保存入库`)
              cursor = actualMaxChapter + 1
              continue
            }
          }
          callbacks.log(`  ❌ 本地修复未能提取到有效蓝图数据`)
          // 降级到 5 章小批次重试
          effectiveBatchSize = Math.min(5, effectiveBatchSize)
          callbacks.log(`  🔄 缩小为 ${effectiveBatchSize} 章/批，从第 ${cursor} 章重新生成...`)
        } else if (consecutiveParseFailures === 2 || consecutiveParseFailures === 3) {
          // 第 2-3 次失败：进一步缩小批次
          effectiveBatchSize = Math.max(1, Math.floor(effectiveBatchSize / 2))
          callbacks.log(`  🔄 继续缩小为 ${effectiveBatchSize} 章/批，从第 ${cursor} 章重试...`)
        } else {
          // 第 4-5 次失败：单章模式
          effectiveBatchSize = 1
          callbacks.log(`  🔄 单章模式重试第 ${cursor} 章...`)
        }

        if (consecutiveParseFailures >= MAX_CONSECUTIVE_FAILURES) {
          callbacks.log(`  ❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次解析失败，中止蓝图生成`)
          throw new Error(`蓝图解析连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，请检查 AI 模型输出格式`)
        }
        // cursor 保持不变，确保不跳过任何章节
      }
    }

    context.data.newBlueprints = newBlueprints
    context.data.existingBlueprints = existingBlueprints

    callbacks.log(`✅ 共生成 ${newBlueprints.length} 章蓝图`)
    return newBlueprints
  }
}
