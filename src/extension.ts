import * as vscode from 'vscode'
import { ProfileManager } from './auth/profile-manager'
import {
  createStatusBarItem,
  getStatusBarItem,
  updateProfileStatus,
} from './ui/status-bar'
import { registerCommands } from './commands'
import { debugLog, errorLog } from './utils/log'

let profileManager: ProfileManager | undefined

export function activate(context: vscode.ExtensionContext) {
  debugLog('Codex Profile Switcher activated')

  const statusBarItem = createStatusBarItem()
  context.subscriptions.push(statusBarItem)

  profileManager = new ProfileManager(context)

  const refreshUi = async () => {
    try {
      await refreshProfileUi()
    } catch (error) {
      errorLog('Error refreshing profile UI:', error)
      updateProfileStatus(null, [])
    }
  }

  registerCommands(context, profileManager, refreshUi)

  let profileWatchers: vscode.Disposable | undefined
  const resetProfileWatchers = () => {
    profileWatchers?.dispose()
    profileWatchers = vscode.Disposable.from(
      ...profileManager!.createWatchers(() => {
        void refreshUi()
      }),
    )
  }

  resetProfileWatchers()
  context.subscriptions.push({
    dispose: () => {
      profileWatchers?.dispose()
    },
  })
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('codexSwitch.storageMode') &&
        !event.affectsConfiguration('codexSwitch.remoteFilesRoot')
      ) {
        return
      }
      resetProfileWatchers()
      void refreshUi()
      void profileManager?.syncActiveProfileToCodexAuthFile()
    }),
  )
  void refreshUi()
  void profileManager.syncActiveProfileToCodexAuthFile()
}

async function refreshProfileUi() {
  if (!profileManager) {
    updateProfileStatus(null, [])
    return
  }

  const profiles = await profileManager.listProfiles()
  const activeId = await profileManager.getActiveProfileId()
  if (!activeId) {
    updateProfileStatus(null, profiles)
    return
  }

  const profile = await profileManager.getProfile(activeId)
  if (!profile) {
    await profileManager.setActiveProfileId(undefined)
    updateProfileStatus(null, profiles)
    return
  }

  updateProfileStatus(profile, profiles)
}

export function deactivate() {
  const statusBarItem = getStatusBarItem()
  if (statusBarItem) {
    statusBarItem.dispose()
  }
}
