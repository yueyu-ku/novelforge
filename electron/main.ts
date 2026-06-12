import { app, BrowserWindow } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { closeProjectDatabase } from './database'
import { installGlobalErrorHandlers, logger } from './utils/logger'

import { fileURLToPath } from 'node:url'
import path from 'node:path'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Vela — AI 小说创作 IDE',
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // macOS 使用自定义标题栏
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    logger.info('Main', `开发模式: ${VITE_DEV_SERVER_URL}`)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
    logger.info('Main', '生产模式启动')
  }
}

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  closeProjectDatabase()
  logger.info('Main', '所有窗口已关闭')
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// 应用即将退出时清理
app.on('before-quit', () => {
  closeProjectDatabase()
  logger.info('Main', '应用即将退出')
  logger.close()
})

app.whenReady().then(() => {
  installGlobalErrorHandlers()
  registerIPCHandlers()
  registerMCPHandlers()
  createWindow()
  logger.info('Main', 'Vela 启动完成')
})
