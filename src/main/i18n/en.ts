// English dictionary. Keep keys in sync with zh.ts and ko.ts.
//
// Style: terse, sentence case for buttons/menu items, period-terminated
// sentences for hints. Brand names (Anthropic / OpenAI / Google / Deck)
// are not translated.

export const en = {
  // ---- Menu (top-level) ---------------------------------------------------
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',

  // ---- Menu — App (macOS application menu) --------------------------------
  // {name} is substituted with app.name. Keys mirror Electron roles so
  // they read predictably alongside electron-template.ts.
  'menu.app.about': 'About {name}',
  'menu.app.services': 'Services',
  'menu.app.hide': 'Hide {name}',
  'menu.app.hideOthers': 'Hide Others',
  'menu.app.showAll': 'Show All',
  'menu.app.quit': 'Quit {name}',

  // ---- Menu — Window (macOS) ----------------------------------------------
  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.close': 'Close',
  'menu.window.bringAllToFront': 'Bring All to Front',

  // ---- Menu — File --------------------------------------------------------
  'menu.file.newDeck': 'New Deck…',
  'menu.file.newWindow': 'New Window',
  'menu.file.openFile': 'Open .deck…',
  'menu.file.openFolder': 'Open Folder…',
  'menu.file.editDeck': 'Edit Deck',
  'menu.file.playDeck': 'Play Deck',
  'menu.file.save': 'Save',
  'menu.file.saveAs': 'Save As .deck…',
  'menu.file.revealMac': 'Reveal in Finder',
  'menu.file.revealWin': 'Show in Explorer',
  'menu.file.chats': 'Open Chats Folder',
  'menu.file.settings': 'Settings…',
  'menu.file.closeWindow': 'Close Window',
  'menu.file.closeDeck': 'Close Deck and Return to Launcher',
  'menu.file.quit': 'Quit',

  // ---- Menu — Edit --------------------------------------------------------
  'menu.edit.undo': 'Undo',
  'menu.edit.redo': 'Redo',
  'menu.edit.cut': 'Cut',
  'menu.edit.copy': 'Copy',
  'menu.edit.paste': 'Paste',
  'menu.edit.selectAll': 'Select All',

  // ---- Menu — View --------------------------------------------------------
  'menu.view.reload': 'Reload Preview',
  'menu.view.forceReload': 'Force Reload Preview',
  'menu.view.resetZoom': 'Actual Size',
  'menu.view.zoomIn': 'Zoom In',
  'menu.view.zoomOut': 'Zoom Out',
  'menu.view.toggleFullScreen': 'Toggle Full Screen',
  'menu.view.toggleDevTools': 'Toggle Developer Tools',

  // ---- Dialogs — open / new -----------------------------------------------
  'dialog.openDeck.title': 'Open .deck',
  'dialog.openFolder.title': 'Open deck folder',
  'dialog.openFolder.message': 'Pick a folder containing deck.json and index.html',
  'dialog.failedToOpen.title': 'Failed to open deck',
  'dialog.failedToOpen.message': 'Failed to open deck',
  'dialog.cancel': 'Cancel',
  'dialog.newDeck.title': 'Create new deck',
  'dialog.newDeck.message': 'Pick where to save the new deck',
  'dialog.newDeck.button': 'Create',
  'dialog.pathExists.title': 'Path already exists',
  'dialog.pathExists.message': '"{name}" already exists',
  'dialog.pathExists.detail': 'Pick a different name or delete the existing path first.',
  'dialog.failedToCreate.title': 'Failed to create deck',
  'dialog.failedToCreate.message': 'Failed to create deck',
  'dialog.saveAs.title': 'Save As .deck',
  'dialog.saveAs.message': 'Save a copy of the current deck',
  'dialog.saveAs.button': 'Save',
  'dialog.saved.title': 'Saved',
  'dialog.saved.message': 'Saved {count} files',
  'dialog.saved.showInFinder': 'Show in Finder',
  'dialog.saved.showInFolder': 'Show in Folder',
  'dialog.saveFailed.title': 'Save failed',
  'dialog.saveFailed.message': 'Could not save the deck',
  'dialog.sourceMissing.title': 'Original .deck is gone',
  'dialog.sourceMissing.message': "Can't save back to the original file",
  'dialog.sourceMissing.detail': 'It looks like the file was moved or deleted while you were editing.\n\n{path}',
  'dialog.sourceMissing.saveAs': 'Save As…',
  'dialog.cantOpen.title': "Can't open that",
  'dialog.cantOpen.message': "That doesn't look like a Deck",
  'dialog.cantOpen.detail': 'Drop a .deck file, or a folder containing deck.json.\n\nPath: {path}',
  'dialog.ok': 'OK',

  // ---- Topbar buttons (title / aria-label) --------------------------------
  'topbar.appMenu': 'App menu',
  'topbar.mode.aria': 'View mode',
  'topbar.mode.play': 'Play',
  'topbar.mode.edit': 'Edit',
  'topbar.save.title': 'Save (⌘S)',
  'topbar.save.aria': 'Save deck',
  'topbar.reload.title': 'Reload preview (⌘R)',
  'topbar.reload.aria': 'Reload preview',
  'topbar.settings.title': 'Settings',
  'topbar.settings.aria': 'Open settings',
  'topbar.fullScreen.title': 'Enter full screen',
  'topbar.fullScreen.aria': 'Enter full screen',

  // ---- Launcher -----------------------------------------------------------
  'launcher.title': 'Open a deck.',
  'launcher.lede': 'Pick a file or folder. Or just drag one in.',
  'launcher.newDeck': 'New deck',
  'launcher.openFile': 'Open file',
  'launcher.openFolder': 'Open folder',
  'launcher.recent': 'Recent',
  'launcher.loading': 'Opening…',
  'launcher.forget': 'Forget',
  'launcher.unnamed': '(unnamed)',
  'launcher.openRecentAria': 'Open {name}',

  // ---- Editor: chat empty state -------------------------------------------
  'chat.empty.title': 'Deck AI',
  'chat.empty.body':
    'Ask Deck AI to edit this presentation. It can read and write files, list the directory, and add assets. The preview on the right reloads automatically after edits.',
  'chat.empty.shortcuts':
    '<span class="kbd">⏎</span> send · <span class="kbd">⇧⏎</span> newline · <span class="kbd">Esc</span> stop',
  'chat.empty.dropTip': 'Drop or paste images, video, or fonts to attach.',

  // ---- Editor: composer ---------------------------------------------------
  'composer.placeholder': 'Ask Deck AI…',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
  'composer.dropToAttach': 'Drop to attach',
  'composer.removeBefore': 'Remove the invalid attachments before sending.',
  'composer.wrapInFence': 'Wrap in code fence',
  'composer.newChat.title': 'New chat',
  'composer.newChat.aria': 'Start a new chat',
  'composer.attach.title': 'Attach files',
  'composer.attach.aria': 'Attach files',
  'composer.history.title': 'Chat history',
  'composer.history.aria': 'Open chat history',
  'composer.history.empty': 'No past chats yet.',
  'composer.history.delete.aria': 'Delete chat',
  /** Relative-time formatting for the History popover. Plurals are
   *  handled by separate keys (en) or single keys (zh/ko, no plural). */
  'time.justNow': 'just now',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',
  /** Native file-picker dialog for the Attach button. */
  'dialog.attach.title': 'Attach files',
  'dialog.attach.button': 'Attach',

  // ---- Composer disabled / AI not ready -----------------------------------
  // Status-bar copy when Send is disabled because the AI configuration
  // isn't usable. Keys mirror `AiUnreadyReason` in src/main/ai/provider.ts.
  // Also reused by Settings → Test connection when the same gap blocks ping.
  'composer.disabled.no-key': 'Add an API key in Settings to start chatting.',
  'composer.disabled.no-base-url': 'Set the Base URL for the custom endpoint in Settings.',
  'composer.disabled.no-model-id': 'Set a Model id for the custom endpoint in Settings.',
  'composer.disabled.unknown-builtin-model':
    'The selected model is no longer available. Pick a different model in Settings.',

  // ---- Editor: status bar -------------------------------------------------
  'chat.status.thinking': 'Thinking…',
  'chat.status.attaching': 'Attaching…',
  'chat.status.aiError': 'AI error',
  'chat.status.sendFailed': 'Send failed',
  'chat.status.empty': '(empty reply)',

  // ---- Aria labels --------------------------------------------------------
  'aria.chatInput': 'Chat input',
  'aria.deckChat': 'Deck AI chat',
  'aria.deckPreview': 'Deck preview',
  'aria.resizeChatPanel': 'Resize chat panel',
  'aria.closeSettings': 'Close settings',
  'aria.toggleKey': 'Show / hide key',
  'aria.themeRadiogroup': 'Theme',
  'aria.langRadiogroup': 'Language',

  // ---- Settings overlay ---------------------------------------------------
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.auto': 'Auto',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.hint': 'Auto follows your system setting.',
  'settings.language': 'Language',
  'settings.language.auto': 'Auto',
  'settings.language.hint': 'Auto follows your OS language.',
  'settings.ai': 'AI',
  'settings.provider': 'Provider',
  'settings.provider.builtin': 'Built-in',
  'settings.provider.custom': 'Custom endpoint',
  'settings.provider.label.customOpenai': 'Custom (OpenAI-compatible)',
  'settings.provider.label.customAnthropic': 'Custom (Anthropic-compatible)',
  'settings.provider.label.customResponses': 'Custom (OpenAI Responses)',
  'settings.baseUrl': 'Base URL',
  'settings.baseUrl.hint': 'Full endpoint URL.',
  'settings.baseUrl.hint.customAnthropic': 'Anthropic Messages endpoint. Example: https://api.anthropic.com',
  'settings.model': 'Model',
  'settings.model.hint.builtin': 'Free-form — typos surface on first use.',
  'settings.model.hint.builtinRecommended': 'Free-form — recommended: {model}. Typos surface on first use.',
  'settings.model.placeholder.custom': 'e.g. anthropic/claude-sonnet-4-6',
  'settings.apiKey': 'API key',
  'settings.apiKey.placeholder.empty': 'Paste your API key',
  'settings.apiKey.placeholder.saved': '••••••••  (saved — leave blank to keep)',
  'settings.apiKey.status.saved':
    'A key is saved for {provider}. Leave blank to keep it, or paste a new key to replace it.',
  'settings.apiKey.status.default': 'Stored in your OS keychain via safeStorage.',
  'settings.toggleReveal.title': 'Show / hide',
  'settings.save': 'Save',
  'settings.clearKey': 'Clear key',
  'settings.testConnection': 'Test connection',
  'settings.status.saving': 'Saving…',
  'settings.status.saved': 'Saved.',
  'settings.status.clearing': 'Clearing…',
  'settings.status.clearedKey': 'Cleared key for {provider}.',
  'settings.status.pinging': 'Pinging…',
  'settings.status.pingOk': 'OK — {provider}/{model}: {text}',
  'settings.status.pingFailed': 'Ping failed',
  'settings.encryption.unavailable': "OS keychain is not available on this system. API keys can't be stored securely.",

  // ---- Attachment chips ---------------------------------------------------
  'attach.remove.title': 'Remove',
  'attach.remove.aria': 'Remove {name}',
  'attach.kind.image': 'image',
  'attach.kind.video': 'video',
  'attach.kind.audio': 'audio',
  'attach.kind.font': 'font',
  'attach.kind.file': 'file',
  'attach.reject.sourceCode': '{ext} is source code — paste the text or ask the AI to write it.',
  'attach.reject.tooLarge': 'Over {mb}MB limit.',
  'attach.reject.unsupported': 'Unsupported file type ({label}).',
  'attach.reject.unknown': 'unknown',
} as const

export type DictKey = keyof typeof en
