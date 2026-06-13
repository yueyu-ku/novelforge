/**
 * 工作流共享工具函数
 *
 * 供 architecture-workflow / chapter-workflow 等多个工作流复用的通用逻辑
 *
 * 核心组件：
 * 1. withRetry — 通用异步重试包装器
 * 2. PostProcessPipeline — 后处理流水线（注册 → 执行 → 持久化 → 修复）
 */

import type { StepCallbacks } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'

// ===== 文本处理通用工具 =====

/**
 * 剥除文本中可能包含的 <think>...</think> 思维链标签
 * 用于清洗大模型在生成正文时输出的思维链，避免其被持久化写入磁盘文件
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text
  // 支持只有 <think> 没有闭合标签的情况
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

// ===== Markdown 表格解析 =====

/** 表头别名映射：AI 可能使用中文/英文/缩写表头，统一映射到标准字段名 */
const HEADER_ALIASES: Record<string, string> = {
  // chapterNumber
  'chapterNumber': 'chapterNumber', 'chapternumber': 'chapterNumber',
  '章节': 'chapterNumber', '章节号': 'chapterNumber', '章': 'chapterNumber',
  'chapter': 'chapterNumber', 'number': 'chapterNumber', '#': 'chapterNumber',
  '序号': 'chapterNumber',
  // title
  'title': 'title', '标题': 'title', '章节标题': 'title',
  'chapterTitle': 'title', 'chapter_title': 'title', '名称': 'title',
  // role
  'role': 'role', '定位': 'role', '章节定位': 'role',
  '角色定位': 'role', '功能': 'role', '作用': 'role',
  // purpose
  'purpose': 'purpose', '小目标': 'purpose', '核心目标': 'purpose',
  'goal': 'purpose', '本章目标': 'purpose', '目标': 'purpose',
  // characters
  'characters': 'characters', '角色': 'characters', '出场角色': 'characters',
  '人物': 'characters', 'characterList': 'characters', 'character_list': 'characters',
  '登场': 'characters',
  // keyEvents
  'keyEvents': 'keyEvents', 'key_events': 'keyEvents', 'keyevents': 'keyEvents',
  '核心事件': 'keyEvents', '关键事件': 'keyEvents', 'events': 'keyEvents',
  '剧情': 'keyEvents', '核心剧情': 'keyEvents', '事件': 'keyEvents',
  // suspenseHook
  'suspenseHook': 'suspenseHook', 'suspense_hook': 'suspenseHook',
  'suspensehook': 'suspenseHook', '悬念': 'suspenseHook', '钩子': 'suspenseHook',
  'hook': 'suspenseHook', '悬念钩子': 'suspenseHook', '结尾': 'suspenseHook',
}

/**
 * 从 AI 原始输出中解析 Markdown 表格
 *
 * 处理 AI 常见的表格输出形式：
 * - 标准 Markdown 表格（| header | header |）
 * - 带分隔行的表格（|---|---|）
 * - ```markdown 代码块包裹的表格
 * - 表格前后的说明文字
 * - 中文/英文混用表头
 *
 * @returns 解析后的行数据数组，或 null（未检测到有效表格）
 */
export function parseMarkdownTable(text: string): Array<Record<string, string>> | null {
  if (!text) return null

  // 1. 尝试提取 markdown 代码块内的表格（支持多种代码块格式）
  let content = text
  const codeBlockMatch = content.match(/```(?:markdown|md|table)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim()
  }

  // 2. 规范化换行符
  const lines = content.split(/\r?\n/)

  // 3. 找到分隔行（更宽松的匹配：|----|----| 或 |:---|:---:| 等变体）
  const separatorLineRegex = /^\s*\|[\s\-:]+\|[\s\-:|]+\s*$/
  let separatorIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (separatorLineRegex.test(lines[i])) {
      separatorIdx = i
      break
    }
  }

  // 备用：如果标准分隔符没找到，尝试找第一个同时包含 | 和 --- 的行
  if (separatorIdx < 0) {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].includes('|') && lines[i].includes('---')) {
        separatorIdx = i
        break
      }
    }
  }

  if (separatorIdx < 1) return null

  // 4. 解析表头（分隔行上一行）
  const headerLine = lines[separatorIdx - 1]
  const headers = splitTableRow(headerLine)
  if (headers.length < 2) return null

  // 将表头映射到标准字段名，未匹配的保留原名
  const fieldMap: string[] = headers.map(h => {
    const normalized = h.trim()
    return HEADER_ALIASES[normalized] || HEADER_ALIASES[normalized.toLowerCase()] || normalized
  })

  // 5. 收集数据行（分隔行之后，以 | 开头的行）
  const dataRowRegex = /^\s*\|.+\|\s*$/
  const rows: Array<Record<string, string>> = []

  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (!dataRowRegex.test(line)) {
      if (rows.length > 0) break
      continue
    }

    const cells = splitTableRow(line)
    const row: Record<string, string> = {}
    let hasContent = false

    // 动态列处理：遍历所有 cells，超出 fieldMap 的列用 "col_N" 命名
    // 如果 cells 比 fieldMap 多，从 headerLine 重新解析获取完整表头
    const effectiveFields = cells.length > fieldMap.length
      ? [...fieldMap, ...Array.from({ length: cells.length - fieldMap.length }, (_, k) => `col_${fieldMap.length + k + 1}`)]
      : fieldMap

    for (let j = 0; j < cells.length; j++) {
      const value = cells[j].trim()
      if (value) hasContent = true
      if (j < effectiveFields.length) {
        row[effectiveFields[j]] = value
      }
    }

    if (hasContent) rows.push(row)
  }

  if (rows.length === 0) return null

  // 6. 放宽验证：检查是否有任何章节号或标题
  const hasValidData = rows.some(r => {
    const v = r.chapterNumber
    return (v && !isNaN(Number(v)) && Number(v) > 0) || r.title?.trim()
  })

  if (!hasValidData) return null

  return rows
}

/** 分割表格行为 cell 数组 */
function splitTableRow(line: string): string[] {
  // 去掉首尾的 pipe 和空白
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)

  // 按 | 分割（简单场景，不处理转义 |）
  return trimmed.split('|').map(s => s.trim())
}

// ===== 健壮 JSON 解析 =====

/**
 * 从 AI 原始输出中提取并解析 JSON
 *
 * 自动处理 AI 常见的 JSON 格式错误：
 * - markdown ```json 代码块包裹
 * - 尾随逗号
 * - 键名缺引号
 * - 缺失的逗号
 * - 连续逗号
 * - 文本前/后的引导语
 *
 * @param text AI 原始输出文本
 * @param preferArray true = 优先解析为数组，false = 优先解析为对象
 * @returns 解析后的 JSON 值，失败返回 null
 */
export function robustParseJSON(text: string, preferArray: boolean = false): unknown | null {
  if (!text) return null

  let content = text

  // 1. 移除 markdown 代码块
  content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  // 2. 找出 JSON 边界
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  const firstBracket = content.indexOf('[')
  const lastBracket = content.lastIndexOf(']')

  // 决定提取范围
  let extractStart: number
  let extractEnd: number

  if (preferArray && firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    extractStart = firstBracket
    extractEnd = lastBracket
  } else if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    extractStart = firstBrace
    extractEnd = lastBrace
  } else if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    extractStart = firstBracket
    extractEnd = lastBracket
  } else {
    return null // 无有效 JSON 结构
  }

  let jsonStr = content.substring(extractStart, extractEnd + 1)

  // 3. 尝试直接解析
  try {
    return JSON.parse(jsonStr)
  } catch {
    // 继续到自动修复
  }

  // 4. 自动修复常见 AI JSON 格式错误
  try {
    let fixed = jsonStr
      // 尾随逗号: ,]  ,}
      .replace(/,(\s*[}\]])/g, '$1')
      // 缺失前引号的键: { key": → { "key":
      .replace(/([\[{,]\s*)(\w+)":/g, '$1"$2":')
      // 连续字符串间缺逗号: "  " → ","
      .replace(/(")\s+(")/g, '$1,$2')
      // 连续逗号: ,,,,, → ,
      .replace(/,{2,}/g, ',')
      // 开头逗号: [, 或 {,
      .replace(/([\[{])\s*,/g, '$1')
      // 多余尾逗号（再次清理）
      .replace(/,\s*([}\]])/g, '$1')
      // 缺失冒号: "key" "value" 或 "key" value
      .replace(/"(\w+)"\s+"([^"]*)"/g, '"$1": "$2"')
      // 单引号键/值（某些模型会混用）
      .replace(/'/g, '"')
      // ★ 字符串值内的未转义换行（JSON 不允许字面换行）
      .replace(/"([^"]*?\n[^"]*?)"/g, (_, inner: string) => {
        return '"' + inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
      })
      // ★ 缺失键名的前引号: { key": value → { "key": value
      .replace(/([\[{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
      // ★ 数字/布尔值后的意外逗号: 123, } → 123 }
      .replace(/(\d)\s*,\s*}/g, '$1 }')
      .replace(/(true|false|null)\s*,\s*}/g, '$1 }')
      // ★ 空数组/对象后的逗号
      .replace(/\[\s*\]\s*,/g, '[],')
      .replace(/\{\s*\}\s*,/g, '{},')
      // ★ 数组元素间缺逗号: "a" "b" → "a", "b"
      .replace(/(")\s*\n?\s*(")/g, '$1, $2')

    // 修复后重新确定边界
    const fb = fixed.indexOf('[')
    const lb = fixed.lastIndexOf(']')
    const fbk = fixed.indexOf('{')
    const lbk = fixed.lastIndexOf('}')

    if (fb !== -1 && lb !== -1 && lb > fb && (fbk === -1 || fb < fbk)) {
      fixed = fixed.substring(fb, lb + 1)
    } else if (fbk !== -1 && lbk !== -1 && lbk > fbk) {
      fixed = fixed.substring(fbk, lbk + 1)
    }

    return JSON.parse(fixed)
  } catch {
    return null
  }
}

/**
 * 多层级 JSON 提取 + 修复引擎
 *
 * 针对 AI 蓝图输出的常见问题逐层处理：
 * 1. 提取 markdown ```json 代码块
 * 2. 清洗不可解析的控制字符
 * 3. 委托 robustParseJSON 修复 + 解析
 * 4. 兜底：逐对象提取（从混乱输出中捞取每个有效 {chapterNumber: N, ...} 对象）
 *
 * @returns { parsed, repaired } — parsed 是解析结果，repaired 表示是否经过了修复
 */
export function extractAndRepairJSON(
  text: string,
  preferArray: boolean = false,
): { parsed: unknown | null; repaired: boolean } {
  if (!text) return { parsed: null, repaired: false }

  let content = text
  let repaired = false

  // ====== Layer 1: 提取 markdown 代码块 ======
  // 支持 ```json ... ``` 和 ``` ... ``` 两种形式
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeBlockMatch) {
    content = codeBlockMatch[1].trim()
    repaired = true
  }

  // ====== Layer 2: 清洗不可解析字符 ======
  const sanitized = sanitizeJSONText(content)
  if (sanitized !== content) {
    content = sanitized
    repaired = true
  }

  // ====== Layer 2.5: 移除 JSON 前后的文本噪音 ======
  // 找到第一个 { 或 [ 和最后一个 } 或 ]，去除前后无关文本
  const firstBrace = content.indexOf('{')
  const firstBracket = content.indexOf('[')
  const lastBrace = content.lastIndexOf('}')
  const lastBracket = content.lastIndexOf(']')

  let jsonStart = -1
  let jsonEnd = -1

  if (preferArray && firstBracket !== -1 && lastBracket !== -1) {
    jsonStart = firstBracket
    jsonEnd = lastBracket
  } else if (firstBrace !== -1 && lastBrace !== -1) {
    jsonStart = firstBrace
    jsonEnd = lastBrace
  } else if (firstBracket !== -1 && lastBracket !== -1) {
    jsonStart = firstBracket
    jsonEnd = lastBracket
  }

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    const trimmed = content.substring(jsonStart, jsonEnd + 1)
    if (trimmed !== content) {
      content = trimmed
      repaired = true
    }
  }

  // ====== Layer 3: 委托 robustParseJSON ======
  let result = robustParseJSON(content, preferArray)
  if (result !== null) {
    return { parsed: result, repaired }
  }

  // ====== Layer 3.5: 再次尝试 — 用更激进的方式 ======
  // 将内容中的所有空白规范化
  const aggressiveCleaned = content
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (aggressiveCleaned !== content) {
    result = robustParseJSON(aggressiveCleaned, preferArray)
    if (result !== null) {
      return { parsed: result, repaired: true }
    }
  }

  // ====== Layer 4: 兜底 — 逐对象提取 ======
  // 当整个 JSON 结构损坏时，尝试提取每个独立的 { ... } 对象
  // 只保留包含 chapterNumber 字段的对象（蓝图标配字段）
  const objects = extractIndividualObjects(content)
  if (objects.length > 0) {
    // 检查是否有蓝图特征字段
    const blueprintObjects = objects.filter(obj =>
      obj && typeof obj === 'object' && (
        'chapterNumber' in (obj as Record<string, unknown>) ||
        'chapter_number' in (obj as Record<string, unknown>)
      )
    )
    if (blueprintObjects.length > 0) {
      return { parsed: blueprintObjects, repaired: true }
    }
    // 没有蓝图特征，但至少有对象，返回所有对象
    return { parsed: objects, repaired: true }
  }

  return { parsed: null, repaired: false }
}

/** 清洗 JSON 文本中的不可解析字符 */
function sanitizeJSONText(text: string): string {
  return text
    // BOM 头
    .replace(/^﻿/, '')
    // 控制字符（保留 \n \r \t）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 中文引号 → 英文引号（AI 偶尔混用）
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    // 全角逗号/冒号 → 半角
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    // 不可见零宽字符
    .replace(/[​-‏﻿]/g, '')
    // 中文括号 → 英文（JSON 结构用）
    // 注意：仅替换用作 JSON 结构的全角符号，不影响字符串内容
    // 连续空白行
    .replace(/\n{3,}/g, '\n\n')
    // ★ 异常 Unicode 转义序列（AI 有时会输出乱码）
    .replace(/\\u[0-9a-fA-F]{8,}/g, '')
    // ★ 反斜杠后跟非法字符
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    .trim()
}

/**
 * 从混乱文本中逐个提取 { ... } 对象
 * ★ 提取所有嵌套层级的对象（不仅顶层），然后按蓝图特征过滤
 * 修复了：1) 字符串内 { } 破坏深度追踪  2) 嵌套对象丢失
 */
function extractIndividualObjects(text: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []

  // ★ 带字符串感知的括号深度追踪
  // 收集所有 { } 区间（start, end），不管嵌套层级
  let depth = 0
  let inString = false
  let escapeNext = false
  const objectRanges: Array<[number, number]> = []
  const startStack: number[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (ch === '\\' && inString) {
      escapeNext = true
      continue
    }

    if (ch === '"' && !escapeNext) {
      inString = !inString
      continue
    }

    // 仅在字符串外部追踪括号深度
    if (!inString) {
      if (ch === '{') {
        startStack.push(i)
        depth++
      } else if (ch === '}') {
        depth--
        if (startStack.length > 0) {
          const start = startStack.pop()!
          objectRanges.push([start, i])
        }
      }
    }
  }

  // ★ 按区间长度降序排列（优先尝试解析大对象，成功后跳过其包含的小对象）
  objectRanges.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))

  // ★ 已成功解析的区间，避免重复提取嵌套对象
  const coveredRanges: Array<[number, number]> = []

  for (const [start, end] of objectRanges) {
    // 检查该区间是否已被更大对象的成功解析所覆盖
    const isCovered = coveredRanges.some(([cs, ce]) => cs <= start && ce >= end)
    if (isCovered) continue

    const objStr = text.substring(start, end + 1)

    // 跳过太小的片段（至少要有 chapterNumber 字段的长度）
    if (objStr.length < 30) continue

    try {
      // 尝试修复后解析
      const fixed = objStr
        .replace(/,(\s*})/g, '$1')
        .replace(/'/g, '"')
      const parsed = JSON.parse(fixed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        results.push(parsed as Record<string, unknown>)
        coveredRanges.push([start, end])
      }
    } catch {
      // 单个对象解析失败，尝试更深层修复
      try {
        const deepFixed = repairSingleObject(objStr)
        if (deepFixed) {
          const parsed = JSON.parse(deepFixed)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            results.push(parsed as Record<string, unknown>)
            coveredRanges.push([start, end])
          }
        }
      } catch {
        // 彻底失败，跳过该对象
      }
    }
  }

  return results
}

/**
 * 尝试修复单个 JSON 对象字符串
 * 比 robustParseJSON 更激进，针对单对象场景
 */
function repairSingleObject(objStr: string): string | null {
  try {
    let fixed = objStr
    // 移除尾随逗号
    fixed = fixed.replace(/,(\s*})/g, '$1')
    // 单引号 → 双引号
    fixed = fixed.replace(/'/g, '"')
    // 修复键名缺引号: { key: → { "key":
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
    // 修复字符串值内的未转义换行符（将 \n 字面量替换为 \\n）
    // 仅在字符串值内部处理
    fixed = fixed.replace(/"([^"]*?\n[^"]*?)"/g, (_, inner) => {
      return '"' + inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
    })
    // 连续逗号
    fixed = fixed.replace(/,{2,}/g, ',')
    // 冒号后缺空格不影响 JSON.parse，但冒号前多余空格要清理
    fixed = fixed.replace(/\[\s*,/g, '[')
    return fixed
  } catch {
    return null
  }
}

// ===== 通用重试包装器 =====

/**
 * 带重试的异步操作包装器
 * @param fn 要执行的异步函数
 * @param maxRetries 最大重试次数（不含首次执行）
 * @param label 操作标签（用于日志）
 * @param callbacks 步骤回调（用于输出日志）
 * @returns 成功返回 { ok: true }，全部失败返回 { ok: false, error }
 */
export async function withRetry(
  fn: () => Promise<void>,
  maxRetries: number,
  label: string,
  callbacks: StepCallbacks,
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn()
      return { ok: true, attempts: attempt + 1 }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (attempt < maxRetries) {
        callbacks.log(`  ⚠️ ${label} 第${attempt + 1}次失败，正在重试...（${errMsg}）`)
      } else {
        return { ok: false, error: errMsg, attempts: attempt + 1 }
      }
    }
  }
  return { ok: false, error: '未知错误', attempts: maxRetries + 1 }
}

// ===== 后处理流水线 =====

/** 单个后处理步骤定义 */
export interface PostProcessStep {
  /** 唯一标识，如 'chapter_notes' */
  key: string
  /** 展示名称，如 '📋 章节要点' */
  label: string
  /** 关键步骤（失败阻断下游工作流） */
  critical: boolean
  /** 步骤执行器 */
  executor: (callbacks: StepCallbacks) => Promise<void>
}

/** 单步后处理执行结果（持久化到状态文件） */
export interface PostProcessStepResult {
  label: string
  critical: boolean
  ok: boolean
  completedAt?: string
  error?: string
  lastAttemptAt: string
  attemptCount: number
}

/** 后处理状态（持久化到 .vela/post_process/{scope}.json） */
export interface PostProcessStatus {
  /** 唯一标识，如 'chapter_1_finalize' */
  scope: string
  /** 来源描述，如 '第1章定稿' */
  sourceLabel: string
  /** 首次执行时间 */
  createdAt: string
  /** 最后更新时间 */
  updatedAt: string
  /** 各步骤执行结果 */
  steps: Record<string, PostProcessStepResult>
  /** 所有关键步骤是否通过 */
  allCriticalPassed: boolean
}

/** 解析原有 scope 字符串为 sourceType 和 sourceId */
function parseScope(scope: string): { sourceType: string; sourceId: string } {
  const match = scope.match(/^chapter_(\d+)_finalize$/)
  if (match) return { sourceType: 'chapter_finalize', sourceId: match[1] }
  return { sourceType: 'unknown', sourceId: scope }
}

/** 读取后处理状态 (向后兼容 UI) */
export async function readPostProcessStatus(
  _projectPath: string,
  scope: string,
): Promise<PostProcessStatus | null> {
  try {
    const { sourceType, sourceId } = parseScope(scope)
    const run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
    if (!run) return null

    const steps = await ipc.invoke('db:post-process-get-steps', run.id)

    const status: PostProcessStatus = {
      scope,
      sourceLabel: run.sourceLabel,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      allCriticalPassed: run.allCriticalPassed,
      steps: {}
    }

    for (const s of steps) {
      status.steps[s.stepKey] = {
        label: s.label,
        critical: s.critical,
        ok: s.ok,
        completedAt: s.completedAt || undefined,
        error: s.errorMsg || undefined,
        lastAttemptAt: s.lastAttemptAt || '',
        attemptCount: s.attemptCount
      }
    }

    return status
  } catch {
    return null
  }
}

/** 快捷检查：所有关键步骤是否通过 */
export async function isAllCriticalPassed(
  _projectPath: string,
  scope: string,
): Promise<boolean> {
  const { sourceType, sourceId } = parseScope(scope)
  return await ipc.invoke('db:post-process-is-all-passed', sourceType, sourceId)
}

/** 提取失败步骤的展示标签列表 */
export function getFailedStepLabels(status: PostProcessStatus): string[] {
  return Object.values(status.steps)
    .filter(s => !s.ok)
    .map(s => s.label)
}

/** 获取章节定稿后处理的 scope 标识 */
export function getChapterFinalizeScope(chapterNumber: number): string {
  return `chapter_${chapterNumber}_finalize`
}

// ===== 流水线执行器 =====

export interface PipelineOptions {
  /** 每步重试次数，默认 2 */
  retryCount?: number
  /** true = 只重跑失败步骤（修复模式） */
  onlyFailed?: boolean
}

/**
 * 执行后处理流水线
 *
 * @param projectPath 项目路径（用于状态文件读写）
 * @param scope 状态文件唯一标识
 * @param sourceLabel 来源描述（展示用）
 * @param steps 步骤列表
 * @param callbacks 工作流回调
 * @param options 可选配置
 * @returns 完整的后处理状态
 */
export async function runPostProcessPipeline(
  projectPath: string,
  scope: string,
  sourceLabel: string,
  steps: PostProcessStep[],
  callbacks: StepCallbacks,
  options?: PipelineOptions,
): Promise<PostProcessStatus> {
  const retryCount = options?.retryCount ?? 2
  const onlyFailed = options?.onlyFailed ?? false

  const { sourceType, sourceId } = parseScope(scope)

  // 判断是否存在已有 instance
  let run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)

  if (!onlyFailed || !run) {
    // 新建跑批
    callbacks.log(`  初始化后处理跑批...`)
    const createRes = await ipc.invoke('db:post-process-create-run', {
      triggerSourceType: sourceType,
      triggerSourceId: sourceId,
      sourceLabel,
      steps: steps.map(s => ({ key: s.key, label: s.label, critical: s.critical }))
    })
    if (!createRes.success || !createRes.id) {
      throw new Error(`创建跑批失败: ${createRes.error}`)
    }
    run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
  }

  if (!run) throw new Error('跑批获取异常')

  const runId = run.id
  const runSteps = await ipc.invoke('db:post-process-get-steps', runId)
  const stepMap = new Map((runSteps as unknown as Array<Record<string, unknown>>).map((s) => [s.stepKey, s]))

  for (const step of steps) {
    const existingStep = stepMap.get(step.key)

    // 修复模式：跳过已成功的步骤
    if (onlyFailed && existingStep?.ok) {
      callbacks.log(`  ⏭️ ${step.label} — 已成功，跳过`)
      continue
    }

    const result = await withRetry(() => step.executor(callbacks), retryCount, step.label, callbacks)

    if (result.ok) {
      await ipc.invoke('db:post-process-mark-step-ok', runId, step.key)
    } else {
      await ipc.invoke('db:post-process-mark-step-failed', runId, step.key, result.error || '未知错误')
    }
  }

  // 返回最终状态汇总供 UI 展示
  const status = await readPostProcessStatus(projectPath, scope)
  if (!status) {
    throw new Error('汇总状态获取失败')
  }

  // 最终汇总
  const failedSteps = Object.values(status.steps).filter(s => !s.ok)
  const successSteps = Object.values(status.steps).filter(s => s.ok)

  callbacks.log('')
  callbacks.log(`━━━━━━━━━━ ${sourceLabel} 后处理汇总 ━━━━━━━━━━`)
  for (const [, r] of Object.entries(status.steps)) {
    callbacks.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : ` — ${r.error}`}`)
  }
  callbacks.log(`━━━━━━━━━━ ${successSteps.length}/${Object.keys(status.steps).length} 成功 ━━━━━━━━━━`)

  if (failedSteps.length > 0) {
    const failedLabels = failedSteps.map(r => r.label).join('、')
    callbacks.log(`⚠️ 以下后处理步骤失败：${failedLabels}`)
    if (failedSteps.some(s => s.critical)) {
      callbacks.log('💡 存在关键步骤失败，后续流程可能被阻断。请在对应页面使用「重试」功能修复')
    }
  }

  return status
}
