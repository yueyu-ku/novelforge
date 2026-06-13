/**
 * RefineParagraphsCommand — 段落级差异修改（非全文重写）
 *
 * 用户选中特定段落，指定改写方向（扩写/缩写/改风格/增强冲突/润色），
 * AI 只修改选中部分，其余内容保持不变。
 * 利用 diff-match-patch 生成差异供用户逐段接受/拒绝。
 */

import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { ipc } from '../../ipc-client'

export interface RefineParagraphsParams {
  /** 完整原文 */
  fullContent: string
  /** 选中的段落起始位置（字符索引） */
  selectionStart: number
  /** 选中的段落结束位置（字符索引） */
  selectionEnd: number
  /** 改写指令 */
  instruction: string
  /** 改写类型 */
  refineType: 'expand' | 'shrink' | 'style' | 'conflict' | 'polish'
}

export interface RefineParagraphsResult {
  /** 修改后的完整文本 */
  modifiedContent: string
  /** 变更摘要 */
  summary: string
  /** 字数变化 */
  wordDelta: number
}

const REFINE_TYPE_GUIDE: Record<string, string> = {
  expand: '扩写选中段落，增加细节描写和感官体验，目标增加 30-50% 字数。保持原有情节不变。',
  shrink: '精简选中段落，删除冗余修饰，压缩到原文 60-70% 字数。保留核心情节和关键对话。',
  style: '按照指定文风改写选中段落。保持情节不变，改变表达方式。',
  conflict: '增强选中段落的冲突感和张力。加入更多内心挣扎、外部压力或反转元素。',
  polish: '润色选中段落，修正语病、优化措辞、提升流畅度。不改变情节和字数。',
}

export class RefineParagraphsCommand extends BaseWorkflowCommand<RefineParagraphsResult> {
  constructor(private params: RefineParagraphsParams) { super() }

  async execute({ callbacks }: CommandExecuteParams): Promise<RefineParagraphsResult> {
    const { fullContent, selectionStart, selectionEnd, instruction, refineType } = this.params

    // 提取选中段落及其上下文
    const selectedText = fullContent.slice(selectionStart, selectionEnd)
    if (!selectedText.trim()) throw new Error('选中的段落为空')

    // 提取前后各 200 字作为上下文锚点
    const contextBefore = fullContent.slice(Math.max(0, selectionStart - 200), selectionStart)
    const contextAfter = fullContent.slice(selectionEnd, Math.min(fullContent.length, selectionEnd + 200))

    callbacks.log(`段落改写 (${refineType}): 选中 ${selectedText.length} 字`)

    // 构建 prompt
    const guide = REFINE_TYPE_GUIDE[refineType] || REFINE_TYPE_GUIDE.polish
    const systemPrompt = [
      '你是一个精准的文本编辑。你的任务是只修改指定的段落，保持其余内容完全不变。',
      '',
      `改写类型: ${refineType}`,
      `指导: ${guide}`,
      instruction ? `用户要求: ${instruction}` : '',
      '',
      '【重要规则】',
      '1. 只修改 <<<SELECTED>>> 和 >>>END<<< 之间的内容',
      '2. 上下文锚点（CONTEXT_BEFORE/CONTEXT_AFTER）不能修改，只用于理解语境',
      '3. 输出格式: [CONTEXT_BEFORE]原文前锚点[START]修改后的段落[END][CONTEXT_AFTER]原文后锚点',
      '4. 保持人物性格、世界观设定一致',
    ].filter(Boolean).join('\n')

    const userPrompt = [
      '请改写以下选中段落：',
      '',
      `[CONTEXT_BEFORE]${contextBefore}`,
      `<<<SELECTED>>>`,
      selectedText,
      `>>>END<<<`,
      `[CONTEXT_AFTER]${contextAfter}`,
    ].join('\n')

    const result = await this.callLLM(userPrompt, systemPrompt, callbacks, { cacheScope: 'chapter_refine' })
    const wordDelta = result.length - selectedText.length

    // 解析输出，提取修改后的段落
    let modifiedText = result
    const startMatch = result.match(/\[START\]([\s\S]*?)\[END\]/)
    if (startMatch) {
      modifiedText = startMatch[1].trim()
    }

    // 拼接完整文本
    const modifiedContent =
      fullContent.slice(0, selectionStart) +
      modifiedText +
      fullContent.slice(selectionEnd)

    const summary =
      `${refineType === 'expand' ? '扩写' : refineType === 'shrink' ? '精简' : '改写'}完成: ` +
      `${selectedText.length}字 → ${modifiedText.length}字 (${wordDelta >= 0 ? '+' : ''}${wordDelta})`

    // 创建修订记录
    try {
      const draftMeta = await this.findDraftMeta()
      if (draftMeta) {
        const revIndex = await ipc.invoke('db:revision-next-index', draftMeta.id)
        await ipc.invoke('db:revision-create', {
          baseDraftId: draftMeta.id,
          revisionIndex: revIndex,
          revisionType: 'refine' as const,
          userPrompt: `${refineType}: ${instruction}`,
          content: modifiedContent,
          wordCount: modifiedContent.length,
        })
        callbacks.log(summary)
      }
    } catch {
      // 修订创建失败不影响主流程
    }

    return { modifiedContent, summary, wordDelta }
  }

  private async findDraftMeta(): Promise<{ id: number } | null> {
    try {
      // 从当前编辑器 tab 获取 draft 信息
      const { useEditorStore } = await import('../../../stores/editor-store')
      const activeTab = useEditorStore.getState().tabs.find(t => t.type === 'chapter')
      if (activeTab?.filePath) {
        const { parseDraftMeta } = await import('../chapter-workflow')
        return parseDraftMeta(activeTab.filePath)
      }
    } catch { /* ignore */ }
    return null
  }
}
