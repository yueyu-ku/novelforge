import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, VELA_HOME } from '../utils/config-utils'
import { logger, LogLevel } from '../utils/logger'
import { GlobalConfig } from '../../src/shared/ipc-channels'

const LOG_DIR = path.join(VELA_HOME, 'logs')

export function registerConfigController() {
  /** 读取全局配置 */
  ipcMain.handle('config:get', async () => {
    return readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  })

  /** 保存全局配置 */
  ipcMain.handle('config:set', async (_event, config: Partial<GlobalConfig>) => {
    try {
      const existing = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      const updated = { ...existing, ...config }
      writeJsonFile(GLOBAL_CONFIG_PATH, updated)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 获取 ~/.vela 路径 */
  ipcMain.handle('config:get-vela-home', async () => {
    return VELA_HOME
  })

  // ===== 日志管理 =====

  /** 获取今天的日志文件内容 */
  ipcMain.handle('log:get-today', async (_event, maxLines?: number) => {
    try {
      const logPath = logger.getLogPath()
      if (!fs.existsSync(logPath)) return ''
      const content = fs.readFileSync(logPath, 'utf-8')
      if (!maxLines) return content
      const lines = content.split('\n')
      return lines.slice(-maxLines).join('\n')
    } catch (error) {
      return `读取日志失败: ${error}`
    }
  })

  /** 获取日志文件列表 */
  ipcMain.handle('log:list-files', async () => {
    try {
      if (!fs.existsSync(LOG_DIR)) return []
      return fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('vela-') && f.endsWith('.log'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  })

  /** 读取指定日志文件 */
  ipcMain.handle('log:read-file', async (_event, fileName: string) => {
    try {
      // 安全检查：防止路径遍历
      const safeName = path.basename(fileName)
      if (!safeName.startsWith('vela-') || !safeName.endsWith('.log')) {
        return { success: false, error: '无效的日志文件名' }
      }
      const filePath = path.join(LOG_DIR, safeName)
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '日志文件不存在' }
      }
      return { success: true, content: fs.readFileSync(filePath, 'utf-8') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 记录前端日志（渲染进程通过 IPC 写入） */
  ipcMain.handle('log:write', async (_event, level: LogLevel, source: string, message: string) => {
    switch (level) {
      case LogLevel.DEBUG: logger.debug(source, message); break
      case LogLevel.INFO: logger.info(source, message); break
      case LogLevel.WARN: logger.warn(source, message); break
      case LogLevel.ERROR: logger.error(source, message); break
    }
    return { success: true }
  })
}
