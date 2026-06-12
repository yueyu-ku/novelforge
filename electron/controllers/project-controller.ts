import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { ProjectData } from '../../src/shared/ipc-channels'
import { DIR_VELA_INTERNAL, DIR_PROMPTS } from '../../src/shared/project-paths'
import { initProjectDatabase } from '../database'
import { ProjectCoreRepository } from '../repositories/project-core-repository'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

function loadRecentProjects(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

function addRecentProject(project: RecentProject) {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => p.path !== project.path)
  filtered.unshift(project)
  const trimmed = filtered.slice(0, 20)
  writeJsonFile(RECENT_PROJECTS_PATH, trimmed)
}

export function registerProjectController() {
  // 创建新项目
  ipcMain.handle('project:create', async (_event, config: {
    name: string; path: string; genre: string; targetAudience: string
  }) => {
    try {
      const projectId = randomUUID()
      const projectDir = path.join(config.path, config.name)

      // 仅创建必要的系统目录
      fs.mkdirSync(path.join(projectDir, DIR_VELA_INTERNAL), { recursive: true })
      fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })

      // 初始化 DB 底座
      initProjectDatabase(projectDir)

      // 初始化 project_core 记录
      ProjectCoreRepository.init(config.name)
      ProjectCoreRepository.update({
        genre: config.genre,
        targetAudience: config.targetAudience,
      })

      // 补充缺失在 DB 初始化时生成所需的数据
      const coreData = ProjectCoreRepository.get()
      const projectData: ProjectData = {
        id: projectId,
        name: config.name,
        path: projectDir,
        novelConfig: {
          genre: config.genre,
          subGenre: '',
          targetAudience: config.targetAudience,
          totalChapters: 100,
          wordsPerChapter: 3000,
          plotStructure: 'three_act',
          narrativePOV: 'third_limited',
          coreOutline: '',
          worldSetting: '',
          goldenFinger: '',
          protagonistProfile: '',
          globalGuidance: '',
        },
        characterStates: '',
        createdAt: coreData?.createdAt || new Date().toISOString(),
        updatedAt: coreData?.updatedAt || new Date().toISOString(),
      }

      // 添加到最近项目列表
      addRecentProject({ name: config.name, path: projectDir, updatedAt: projectData.updatedAt })

      return { success: true, projectId, projectPath: projectDir }
    } catch (error) {
      return { success: false, projectId: '', error: String(error) }
    }
  })

  // 打开现有项目
  ipcMain.handle('project:open', async (_event, projectPath: string) => {
    try {
      if (!fs.existsSync(projectPath)) {
        return { success: false, project: null, error: '目录不存在' }
      }

      // TODO: 这里可以加入一个检测旧版项目的逻辑（如果有 旧的 01_novel_config.json 等），提示不支持旧格式。
      // 因为新架构不兼容旧项目，这里我们只要初始化 DB 即可
      initProjectDatabase(projectPath)

      // 从 DB 读取配置
      const coreData = ProjectCoreRepository.get()
      if (!coreData) {
        // 如果是从空目录新建并打开，尝试初始化
        const folderName = path.basename(projectPath)
        ProjectCoreRepository.init(folderName)
      }

      // 组装返回给前端的数据结构
      const updatedCoreData = ProjectCoreRepository.get()
      if (!updatedCoreData) {
        return { success: false, project: null, error: '无法读取项目配置，数据库可能未正确初始化' }
      }
      const projectData: ProjectData = {
        id: 'main',
        name: updatedCoreData.projectName,
        path: projectPath,
        novelConfig: {
          genre: updatedCoreData.genre,
          subGenre: updatedCoreData.subGenre,
          targetAudience: updatedCoreData.targetAudience,
          totalChapters: updatedCoreData.totalChapters,
          wordsPerChapter: updatedCoreData.wordsPerChapter,
          plotStructure: updatedCoreData.plotStructure as 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform',
          narrativePOV: updatedCoreData.narrativePov as 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov',
          coreOutline: updatedCoreData.synopsis,      // 旧字段映射
          worldSetting: updatedCoreData.worldbuilding, // 旧字段映射
          goldenFinger: updatedCoreData.goldenFinger,
          protagonistProfile: updatedCoreData.charactersArch, // 旧字段映射
          globalGuidance: updatedCoreData.globalGuidance,
          writingStyle: updatedCoreData.writingStyle,
          referenceWorks: updatedCoreData.referenceWorks,
        },
        characterStates: updatedCoreData.characterStates,
        createdAt: updatedCoreData.createdAt || new Date().toISOString(),
        updatedAt: updatedCoreData.updatedAt || new Date().toISOString(),
      }

      addRecentProject({ name: projectData.name, path: projectPath, updatedAt: projectData.updatedAt })

      return { success: true, project: projectData }
    } catch (error) {
      return { success: false, project: null, error: String(error) }
    }
  })

  // 保存/更新项目配置
  // 注意：novelConfig 字段与 DB project_core 列的映射关系（前后端字段名不同）
  ipcMain.handle('project:save', async (_event, _projectId: string, data: Partial<ProjectData>) => {
    try {
      if (!data.path) return { success: false, error: '缺少项目路径' }

      // 收集所有需要更新的字段，合并为单次 UPDATE
      const updateData: Partial<import('../repositories/project-core-repository').ProjectCoreData> = {}

      if (data.name) {
        updateData.projectName = data.name
      }

      if (data.novelConfig) {
        const nc = data.novelConfig
        if (nc.genre !== undefined) updateData.genre = nc.genre
        if (nc.subGenre !== undefined) updateData.subGenre = nc.subGenre
        if (nc.targetAudience !== undefined) updateData.targetAudience = nc.targetAudience
        if (nc.totalChapters !== undefined) updateData.totalChapters = nc.totalChapters
        if (nc.wordsPerChapter !== undefined) updateData.wordsPerChapter = nc.wordsPerChapter
        if (nc.plotStructure !== undefined) updateData.plotStructure = nc.plotStructure
        if (nc.narrativePOV !== undefined) updateData.narrativePov = nc.narrativePOV
        if (nc.goldenFinger !== undefined) updateData.goldenFinger = nc.goldenFinger
        if (nc.globalGuidance !== undefined) updateData.globalGuidance = nc.globalGuidance
        if (nc.writingStyle !== undefined) updateData.writingStyle = nc.writingStyle
        if (nc.referenceWorks !== undefined) updateData.referenceWorks = nc.referenceWorks
        // 关键修复：反向映射旧字段名 → DB 列名
        if (nc.coreOutline !== undefined) updateData.synopsis = nc.coreOutline
        if (nc.worldSetting !== undefined) updateData.worldbuilding = nc.worldSetting
        if (nc.protagonistProfile !== undefined) updateData.charactersArch = nc.protagonistProfile
      }

      if (data.characterStates !== undefined) {
        updateData.characterStates = data.characterStates
      }

      // 单次批量更新
      ProjectCoreRepository.update(updateData)
      console.log('[project:save] 配置已持久化，字段数:', Object.keys(updateData).length)

      addRecentProject({
        name: data.name ?? 'Unknown',
        path: data.path,
        updatedAt: new Date().toISOString(),
      })

      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // project:update-config 同理
  ipcMain.handle('project:update-config', async (_event, _projectId: string, data: Partial<ProjectData>) => {
    try {
      if (data.novelConfig) {
        const nc = data.novelConfig
        const updateData: Partial<import('../repositories/project-core-repository').ProjectCoreData> = {}
        if (nc.genre !== undefined) updateData.genre = nc.genre
        if (nc.subGenre !== undefined) updateData.subGenre = nc.subGenre
        if (nc.targetAudience !== undefined) updateData.targetAudience = nc.targetAudience
        if (nc.totalChapters !== undefined) updateData.totalChapters = nc.totalChapters
        if (nc.wordsPerChapter !== undefined) updateData.wordsPerChapter = nc.wordsPerChapter
        if (nc.plotStructure !== undefined) updateData.plotStructure = nc.plotStructure
        if (nc.narrativePOV !== undefined) updateData.narrativePov = nc.narrativePOV
        if (nc.goldenFinger !== undefined) updateData.goldenFinger = nc.goldenFinger
        if (nc.globalGuidance !== undefined) updateData.globalGuidance = nc.globalGuidance
        if (nc.writingStyle !== undefined) updateData.writingStyle = nc.writingStyle
        if (nc.referenceWorks !== undefined) updateData.referenceWorks = nc.referenceWorks
        if (nc.coreOutline !== undefined) updateData.synopsis = nc.coreOutline
        if (nc.worldSetting !== undefined) updateData.worldbuilding = nc.worldSetting
        if (nc.protagonistProfile !== undefined) updateData.charactersArch = nc.protagonistProfile
        ProjectCoreRepository.update(updateData)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('project:recent-list', async () => {
    return loadRecentProjects()
  })

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目保存位置',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
