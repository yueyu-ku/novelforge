/**
 * Vela 日志模块 — 主进程使用
 *
 * 功能：
 * - 自动按日切割日志文件，存储于 ~/.vela/logs/vela-YYYY-MM-DD.log
 * - 文件日志分 DEBUG / INFO / WARN / ERROR
 * - 自动捕获未处理的 Promise 拒绝和未捕获异常
 * - 同时输出到终端（带颜色）和文件
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { VELA_HOME } from './config-utils'

// ===== 常量 =====

const LOG_DIR = path.join(VELA_HOME, 'logs')
/** 最多保留 N 天日志 */
const MAX_LOG_DAYS = 7

// ===== 日志等级 =====

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

/** 当前生效的最低日志等级（低于此等级的日志会被静默丢弃） */
let minLevel: LogLevel = LogLevel.DEBUG

// ===== 终端颜色（ANSI） =====

const COLORS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: '\x1b[36m', // 青色
    [LogLevel.INFO]: '\x1b[32m',  // 绿色
    [LogLevel.WARN]: '\x1b[33m',  // 黄色
    [LogLevel.ERROR]: '\x1b[31m', // 红色
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
}

// ===== 文件写入 =====

/** 当前日志文件的写入路径 */
let currentLogPath: string | null = null
/** 文件写入流 */
let logStream: fs.WriteStream | null = null

/** 获取今天的日志文件路径 */
function getTodayLogPath(): string {
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return path.join(LOG_DIR, `vela-${date}.log`)
}

/** 确保日志目录和当日文件就绪 */
function ensureLogStream(): fs.WriteStream {
    const todayPath = getTodayLogPath()

    // 日期变更 → 切换文件
    if (todayPath !== currentLogPath) {
        if (logStream) {
            logStream.end()
            logStream = null
        }
        currentLogPath = todayPath

        // 确保目录存在
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true })
        }

        // 清理过期日志
        cleanupOldLogs()

        logStream = fs.createWriteStream(todayPath, { flags: 'a' })
    }

    return logStream!
}

/** 删除超过 MAX_LOG_DAYS 的日志文件 */
function cleanupOldLogs(): void {
    try {
        const files = fs.readdirSync(LOG_DIR)
        const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000

        for (const file of files) {
            if (!file.startsWith('vela-') || !file.endsWith('.log')) continue
            const filePath = path.join(LOG_DIR, file)
            try {
                const stat = fs.statSync(filePath)
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(filePath)
                }
            } catch { /* 忽略单个文件的错误 */ }
        }
    } catch { /* 目录可能不存在 */ }
}

// ===== 核心写入 =====

/** 格式化一条日志消息 */
function formatMessage(level: LogLevel, source: string, message: string): string {
    const now = new Date()
    const timestamp = now.toISOString()
    const label = LEVEL_LABELS[level]
    return `[${timestamp}] [${label.padEnd(5)}] [${source}] ${message}`
}

/** 写入日志（内部函数） */
function write(level: LogLevel, source: string, message: string): void {
    if (level < minLevel) return

    const formatted = formatMessage(level, source, message)

    // 1. 终端输出（带颜色）
    const color = COLORS[level]
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    const label = LEVEL_LABELS[level]

    if (level >= LogLevel.ERROR) {
        console.error(`${DIM}${time}${RESET} ${color}[${label}]${RESET} ${message}`)
    } else if (level >= LogLevel.WARN) {
        console.warn(`${DIM}${time}${RESET} ${color}[${label}]${RESET} ${message}`)
    } else {
        console.log(`${DIM}${time}${RESET} ${color}[${label}]${RESET} ${message}`)
    }

    // 2. 文件写入
    try {
        const stream = ensureLogStream()
        stream.write(formatted + '\n')
    } catch {
        // 文件写入失败时回退到 console
        console.warn('[Logger] 文件写入失败，仅输出到终端')
    }
}

// ===== 公共 API =====

export const logger = {
    /** 动态设置日志等级 */
    setLevel(level: LogLevel): void {
        minLevel = level
    },

    debug(source: string, message: string): void {
        write(LogLevel.DEBUG, source, message)
    },

    info(source: string, message: string): void {
        write(LogLevel.INFO, source, message)
    },

    warn(source: string, message: string): void {
        write(LogLevel.WARN, source, message)
    },

    error(source: string, message: string | Error): void {
        const msg = message instanceof Error
            ? `${message.message}\n${message.stack ?? '(无堆栈)'}`
            : message
        write(LogLevel.ERROR, source, msg)
    },

    /** 获取今天的日志文件路径 */
    getLogPath(): string {
        return getTodayLogPath()
    },

    /** 关闭日志流（应用退出时调用） */
    close(): void {
        if (logStream) {
            logStream.end()
            logStream = null
            currentLogPath = null
        }
    },
}

// ===== 全局异常处理 =====

/** 记录未捕获异常 */
function captureUncaughtException(error: Error): void {
    logger.error('Process', `未捕获异常: ${error.message}`)
    logger.error('Process', error)
}

/** 记录未处理的 Promise 拒绝 */
function captureUnhandledRejection(reason: unknown): void {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
    logger.error('Process', `未处理 Promise 拒绝: ${msg}`)
}

/** 安装全局异常处理器（在 app.whenReady() 之前调用） */
export function installGlobalErrorHandlers(): void {
    process.on('uncaughtException', captureUncaughtException)
    process.on('unhandledRejection', captureUnhandledRejection)

    logger.info('Logger', `日志系统已初始化，日志目录: ${LOG_DIR}`)
    logger.info('Logger', `平台: ${os.platform()} ${os.release()} | Node: ${process.version} | 架构: ${os.arch()}`)
}

/** 卸载全局异常处理器（应用退出时调用） */
export function uninstallGlobalErrorHandlers(): void {
    process.off('uncaughtException', captureUncaughtException)
    process.off('unhandledRejection', captureUnhandledRejection)
    logger.close()
}
