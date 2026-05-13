// Undo toast: a small bottom-anchored notification with a countdown
// progress bar and an "Undo" button. Used after a delete-with-undo
// operation. The caller wires the actual undo / commit work; this
// module is just the timed UI.
//
// One toast at a time. Showing a new toast while another is visible
// commits (no-undo) the previous one — matching Gmail's pattern.

const TIMEOUT_MS = 6000

/**
 * @typedef {{ message: string, onUndo: () => void, onCommit: () => void }} ToastSpec
 */

class UndoToast {
  constructor(root) {
    this.root = root            // <div id="undo-toast">
    this.current = null         // active spec, or null
    this.timer = null
    this.startedAt = 0
    this.committedFlag = false  // true if onCommit already ran (avoid double)

    // Build static structure once.
    this.root.innerHTML = ''
    const inner = document.createElement('div')
    inner.className = 'inner'

    this.msgEl = document.createElement('span')
    this.msgEl.className = 'msg'

    this.undoBtn = document.createElement('button')
    this.undoBtn.type = 'button'
    this.undoBtn.className = 'undo'
    this.undoBtn.textContent = 'Undo'
    this.undoBtn.addEventListener('click', () => this.undo())

    inner.append(this.msgEl, this.undoBtn)

    this.progress = document.createElement('div')
    this.progress.className = 'progress'

    this.root.append(inner, this.progress)
  }

  /**
   * Show the toast. If one is already visible, commit it first so its
   * onCommit fires before the new toast replaces it.
   * @param {ToastSpec} spec
   */
  show(spec) {
    // Replace any in-flight toast with the new one.
    if (this.current) this.commit()

    this.current = spec
    this.committedFlag = false
    this.msgEl.textContent = spec.message
    this.root.classList.add('active')
    this.startedAt = Date.now()

    // Reset and start the progress bar animation.
    this.progress.style.transition = 'none'
    this.progress.style.transform = 'scaleX(1)'
    // Force reflow so the new transform applies before we change it.
    void this.progress.offsetWidth
    this.progress.style.transition = 'transform ' + TIMEOUT_MS + 'ms linear'
    this.progress.style.transform = 'scaleX(0)'

    this.timer = setTimeout(() => this.commit(), TIMEOUT_MS)
  }

  undo() {
    if (!this.current) return
    const spec = this.current
    this.cleanup()
    spec.onUndo()
  }

  commit() {
    if (!this.current || this.committedFlag) return
    const spec = this.current
    this.committedFlag = true
    this.cleanup()
    spec.onCommit()
  }

  cleanup() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.root.classList.remove('active')
    this.current = null
  }
}

let singleton = null
export function getToast(root) {
  if (!singleton) singleton = new UndoToast(root)
  return singleton
}
