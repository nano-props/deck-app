// Settings modal — overlay shell + the AI provider/key form inside it.
// The modal is mounted in app.html (hidden by default); this module only
// wires the open/close behavior and the form logic.

// ---- Overlay shell ---------------------------------------------------------

const settingsOverlay = document.getElementById('settingsOverlay')
const overlayBackdrop = document.getElementById('overlayBackdrop')
const closeSettingsBtn = document.getElementById('closeSettings')
const settingsBtn = document.getElementById('settingsBtn')

let lastFocusBeforeOverlay = null

function openSettingsOverlay() {
  lastFocusBeforeOverlay = document.activeElement
  settingsOverlay.hidden = false
  // Hide the deckView. Cross-WebContentsView stacking is by addChildView
  // order, not CSS z-index, so the preview is ALWAYS on top of this
  // chromeView — overlays here get clipped where they overlap the
  // preview. Hiding the deckView for the duration of the modal is the
  // simplest fix that keeps the overlay full-window.
  window.deck.setDeckViewVisible?.(false)
  // inert the rest of the UI so keyboard can't tab into it.
  document.querySelectorAll('body > header, .body').forEach((el) => {
    el.setAttribute('inert', '')
  })
  void initSettings()
  // Focus first focusable inside the overlay.
  requestAnimationFrame(() => {
    const first = settingsOverlay.querySelector('select, input, button')
    if (first instanceof HTMLElement) first.focus()
  })
}
function closeSettingsOverlay() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const finish = () => {
    settingsOverlay.classList.remove('closing')
    settingsOverlay.hidden = true
    window.deck.setDeckViewVisible?.(true)
    document.querySelectorAll('body > header, .body').forEach((el) => {
      el.removeAttribute('inert')
    })
    if (lastFocusBeforeOverlay instanceof HTMLElement) lastFocusBeforeOverlay.focus()
  }
  if (reduceMotion) {
    finish()
    return
  }
  settingsOverlay.classList.add('closing')
  const panel = settingsOverlay.querySelector('.overlay-panel')
  const onEnd = () => {
    panel?.removeEventListener('animationend', onEnd)
    finish()
  }
  panel?.addEventListener('animationend', onEnd, { once: true })
}

settingsBtn.addEventListener('click', openSettingsOverlay)
overlayBackdrop.addEventListener('click', closeSettingsOverlay)
closeSettingsBtn.addEventListener('click', closeSettingsOverlay)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsOverlay.hidden) {
    e.preventDefault()
    closeSettingsOverlay()
  }
})
window.deck.onOpenSettings?.(() => openSettingsOverlay())

// ---- Form ------------------------------------------------------------------

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'custom-openai': 'Custom (OpenAI-compatible)',
  'custom-anthropic': 'Custom (Anthropic-compatible)',
  'custom-responses': 'Custom (OpenAI Responses)',
}
const BUILTIN_IDS = ['anthropic', 'openai', 'google']
const CUSTOM_IDS = ['custom-openai', 'custom-anthropic', 'custom-responses']
const BASEURL_HINT = {
  'custom-openai':
    'OpenAI Chat Completions endpoint. Examples: https://openrouter.ai/api/v1, https://api.deepseek.com, http://localhost:11434/v1 (Ollama).',
  'custom-anthropic': 'Anthropic Messages endpoint. Example: https://api.anthropic.com',
  'custom-responses': 'OpenAI Responses endpoint. Example: https://api.openai.com/v1',
}
const RECOMMENDED_MODEL = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.1', google: 'gemini-3-pro-preview' }

const providerSel = document.getElementById('provider')
const modelInput = document.getElementById('model')
const modelHint = document.getElementById('modelHint')
const baseUrlField = document.getElementById('baseUrlField')
const baseUrlInput = document.getElementById('baseUrl')
const baseUrlHint = document.getElementById('baseUrlHint')
const apiKeyInput = document.getElementById('apiKey')
const toggleReveal = document.getElementById('toggleReveal')
const saveBtn = document.getElementById('saveBtn')
const clearKeyBtn = document.getElementById('clearKeyBtn')
const pingBtn = document.getElementById('pingBtn')
const pingStatus = document.getElementById('pingStatus')
const keyStatus = document.getElementById('keyStatus')
const encryptionWarning = document.getElementById('encryptionWarning')

let settingsState = {
  provider: 'anthropic',
  builtinModel: { anthropic: '', openai: '', google: '' },
  custom: {
    'custom-openai': { baseUrl: '', model: '' },
    'custom-anthropic': { baseUrl: '', model: '' },
    'custom-responses': { baseUrl: '', model: '' },
  },
  configured: {
    anthropic: false,
    openai: false,
    google: false,
    'custom-openai': false,
    'custom-anthropic': false,
    'custom-responses': false,
  },
}
function isCustom(id) {
  return id.startsWith('custom-')
}
function populateProviders() {
  providerSel.innerHTML = ''
  const g1 = document.createElement('optgroup')
  g1.label = 'Built-in'
  for (const p of BUILTIN_IDS) {
    const o = document.createElement('option')
    o.value = p
    o.textContent = PROVIDER_LABELS[p]
    g1.appendChild(o)
  }
  providerSel.appendChild(g1)
  const g2 = document.createElement('optgroup')
  g2.label = 'Custom endpoint'
  for (const p of CUSTOM_IDS) {
    const o = document.createElement('option')
    o.value = p
    o.textContent = PROVIDER_LABELS[p]
    g2.appendChild(o)
  }
  providerSel.appendChild(g2)
}
function renderProviderMode() {
  const custom = isCustom(settingsState.provider)
  baseUrlField.hidden = !custom
  if (custom) {
    baseUrlHint.textContent = BASEURL_HINT[settingsState.provider] || ''
    baseUrlInput.value = settingsState.custom[settingsState.provider]?.baseUrl ?? ''
    modelInput.value = settingsState.custom[settingsState.provider]?.model ?? ''
    modelInput.placeholder = 'e.g. anthropic/claude-sonnet-4-6'
    modelHint.textContent = 'The model id the endpoint recognizes. Free-form — typos surface on first use.'
  } else {
    const recommended = RECOMMENDED_MODEL[settingsState.provider] ?? ''
    if (!settingsState.builtinModel[settingsState.provider]) {
      settingsState.builtinModel[settingsState.provider] = recommended
    }
    modelInput.value = settingsState.builtinModel[settingsState.provider]
    modelInput.placeholder = recommended
    modelHint.textContent = recommended
      ? `Free-form — recommended: ${recommended}. Typos surface on first use.`
      : 'Free-form — typos surface on first use.'
  }
}
function captureModelInput() {
  if (isCustom(settingsState.provider)) {
    settingsState.custom[settingsState.provider].model = modelInput.value
  } else {
    settingsState.builtinModel[settingsState.provider] = modelInput.value
  }
}
function renderKeyStatus() {
  const p = settingsState.provider
  const configured = settingsState.configured[p]
  keyStatus.textContent = configured
    ? `A key is saved for ${PROVIDER_LABELS[p]}. Leave blank to keep it, or paste a new key to replace it.`
    : `No key saved for ${PROVIDER_LABELS[p]}. Paste your key and click Save.`
  apiKeyInput.placeholder = configured ? '••••••••  (saved — leave blank to keep)' : 'Paste your API key'
  apiKeyInput.value = ''
}
function setPingStatus(kind, msg) {
  pingStatus.classList.remove('ok', 'err')
  if (kind) pingStatus.classList.add(kind)
  pingStatus.textContent = msg
}
async function initSettings() {
  populateProviders()
  const encOk = await window.deck.settings.encryptionAvailable()
  if (!encOk) {
    encryptionWarning.hidden = false
    saveBtn.disabled = true
  }
  const saved = await window.deck.settings.load()
  settingsState.provider = saved.ai.provider
  // Main persists one model per builtin provider (saved.ai.builtinModel).
  // Copy the whole map so flipping between providers in the form keeps
  // their per-provider selections intact.
  if (saved.ai.builtinModel && typeof saved.ai.builtinModel === 'object') {
    for (const p of BUILTIN_IDS) {
      if (typeof saved.ai.builtinModel[p] === 'string') {
        settingsState.builtinModel[p] = saved.ai.builtinModel[p]
      }
    }
  }
  settingsState.custom = saved.ai.custom
  settingsState.configured = await window.deck.settings.listConfiguredProviders()
  providerSel.value = settingsState.provider
  renderProviderMode()
  renderKeyStatus()
}
providerSel.addEventListener('change', () => {
  captureModelInput()
  settingsState.provider = providerSel.value
  renderProviderMode()
  renderKeyStatus()
  setPingStatus('', '')
})
modelInput.addEventListener('input', captureModelInput)
baseUrlInput.addEventListener('input', () => {
  if (isCustom(settingsState.provider)) settingsState.custom[settingsState.provider].baseUrl = baseUrlInput.value
})
toggleReveal.addEventListener('click', () => {
  const r = toggleReveal.getAttribute('data-revealed') === 'true'
  toggleReveal.setAttribute('data-revealed', String(!r))
  apiKeyInput.type = r ? 'password' : 'text'
})
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true
  setPingStatus('', 'Saving…')
  try {
    captureModelInput()
    // Send every builtin bucket we've tracked, not just the active one —
    // main stores one model per builtin provider, so a save after
    // flipping anthropic → openai → anthropic must preserve both.
    await window.deck.settings.save({
      ai: {
        provider: settingsState.provider,
        builtinModel: { ...settingsState.builtinModel },
        custom: settingsState.custom,
      },
    })
    const newKey = apiKeyInput.value.trim()
    if (newKey) {
      await window.deck.settings.setApiKey(settingsState.provider, newKey)
      settingsState.configured[settingsState.provider] = true
    }
    renderKeyStatus()
    setPingStatus('ok', 'Saved.')
  } catch (e) {
    setPingStatus('err', e?.message || String(e))
  } finally {
    saveBtn.disabled = false
  }
})
clearKeyBtn.addEventListener('click', async () => {
  setPingStatus('', 'Clearing…')
  try {
    await window.deck.settings.clearApiKey(settingsState.provider)
    settingsState.configured[settingsState.provider] = false
    renderKeyStatus()
    setPingStatus('ok', `Cleared key for ${PROVIDER_LABELS[settingsState.provider]}.`)
  } catch (e) {
    setPingStatus('err', e?.message || String(e))
  }
})
pingBtn.addEventListener('click', async () => {
  pingBtn.disabled = true
  setPingStatus('', 'Pinging…')
  try {
    const r = await window.deck.settings.ping()
    if (r.ok) setPingStatus('ok', `OK — ${r.provider}/${r.model}: ${r.text || '(empty reply)'}`)
    else setPingStatus('err', r.error || 'Ping failed')
  } catch (e) {
    setPingStatus('err', e?.message || String(e))
  } finally {
    pingBtn.disabled = false
  }
})
