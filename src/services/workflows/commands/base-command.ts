import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { robustParseJSON } from '../workflow-utils'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {

  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext
  ): Promise<string> {
    const llmStore = useLLMStore.getState()
    if (!llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

    const modelId = llmStore.defaultModelId
    const model = llmStore.models.find(m => m.id === modelId)
    const startTime = Date.now()

    callbacks.setProgress(10)

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => { })
            reject(new Error('工作流已取消'))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      const logLLMCall = (success: boolean, errorMessage?: string) => {
        const duration = Date.now() - startTime
        ipc.invoke('db:log-llm-call', {
          model_id: modelId,
          model_name: model?.name ?? model?.modelName ?? '',
          purpose: 'workflow',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          duration_ms: duration,
          success: success ? 1 : 0,
          error_message: errorMessage ?? '',
        }).catch(() => { /* 日志失败不影响主流程 */ })
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text, usage) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效
            if (context?.cancelled) {
              logLLMCall(false, '工作流已取消')
              reject(new Error('工作流已取消'))
              return
            }
            // 更新 token 用量（如果 provider 提供了 usage）
            if (usage) {
              ipc.invoke('db:log-llm-call', {
                model_id: modelId,
                model_name: model?.name ?? model?.modelName ?? '',
                purpose: 'workflow',
                prompt_tokens: usage.promptTokens,
                completion_tokens: usage.completionTokens,
                total_tokens: usage.totalTokens,
                duration_ms: Date.now() - startTime,
                success: 1,
              }).catch(() => { })
            } else {
              logLLMCall(true)
            }
            callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            resolve(cleaned)
          },
          onError: (err) => {
            cleanup()
            logLLMCall(false, err || '流式生成失败')
            reject(new Error(err || '流式生成失败'))
          }
        },
        undefined,
        options
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => { })
          cleanup()
          logLLMCall(false, '工作流已取消')
          reject(new Error('工作流已取消'))
        }
      }).catch(err => {
        cleanup()
        logLLMCall(false, String(err))
        reject(err)
      })
    })
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  }

  /**
   * 全局容错 JSON 解析器
   * 复用 workflow-utils 中的健壮解析逻辑，统一处理 AI 输出格式错误
   */
  protected parseJSON<T>(text: string): T {
    // 先尝试对象解析（AI 通常返回 JSON 对象），再尝试数组
    let result = robustParseJSON(text, false)
    if (!result) {
      result = robustParseJSON(text, true)
    }

    if (result === null) {
      throw new Error(`AI 返回的数据格式乱码，无法解析为有效层级结构。尝试解析内容末端: ${text.slice(-100)}`)
    }

    return result as T
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(resources: EventPayloadMap['REFRESH_RESOURCE']['resources']) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources })
  }
}

