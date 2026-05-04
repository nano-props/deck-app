// Reusable custom scrollbar component — naive-ui-inspired.
//
// Usage:
//
//   <div class="scroller">
//     <div class="scroller-content">...</div>
//     <div class="scroller-rail"><div class="scroller-thumb"></div></div>
//   </div>
//
//   import { Scrollbar } from './scrollbar.js'
//   const bar = Scrollbar.mount(scrollerEl)       // auto-finds content/rail/thumb
//   bar.update()                                   // force recompute
//   bar.destroy()                                  // detach observers & listeners
//
// The native scroll container still owns scrolling. Keyboard, wheel,
// touchpad, and programmatic `scrollTop` writes all work unchanged — the
// rail/thumb are a visual overlay whose geometry mirrors the content's
// scroll state.
//
// Selectors are overridable for cases where the consumer wants a different
// class name; defaults match the CSS shipped in app.css.

const DEFAULTS = {
  content: '.scroller-content',
  rail: '.scroller-rail',
  thumb: '.scroller-thumb',
  minThumb: 20,
  idleMs: 1000,
  pageRatio: 0.9, // clicks on empty rail scroll by ~one viewport
}

export class Scrollbar {
  static mount(root, options) {
    const instance = new Scrollbar(root, options)
    instance.attach()
    return instance
  }

  constructor(root, options = {}) {
    this.root = root
    this.opts = { ...DEFAULTS, ...options }
    this.content = root.querySelector(this.opts.content)
    this.rail = root.querySelector(this.opts.rail)
    this.thumb = root.querySelector(this.opts.thumb)
    this._idleTimer = null
    this._drag = null
    this._disposers = []
  }

  attach() {
    if (!this.content || !this.rail || !this.thumb) return this
    if (this._disposers.length) return this // already attached
    this._bindScroll()
    this._bindResizeAndMutation()
    this._bindThumbDrag()
    this._bindRailPaging()
    this.update()
    return this
  }

  destroy() {
    for (const d of this._disposers) d()
    this._disposers = []
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
    // Restore any transient state we owned — a destroy mid-drag should
    // not leave the document un-selectable or the rail stuck visible.
    if (this._drag) {
      document.body.style.userSelect = ''
      this._drag = null
    }
    this.rail?.classList.remove('active', 'scrolling')
  }

  // Recompute thumb size and position from the content's scroll state.
  // Idempotent — safe to call from anywhere.
  //
  // While a thumb drag is in flight, we keep the thumb height frozen at
  // the size captured on mousedown. Otherwise content growing during a
  // drag (streaming tokens, window resize) would shrink thumbH, which
  // would change the effective travel — the drag's cached
  // pointerOffsetInThumb would then point past the new thumb edge and
  // the thumb would jitter. Position still tracks scrollTop so the thumb
  // follows the user's drag.
  update() {
    if (!this.content || !this.rail || !this.thumb) return
    const { scrollTop, scrollHeight, clientHeight } = this.content
    const railH = this.rail.clientHeight
    if (scrollHeight <= clientHeight || railH <= 0) {
      this.thumb.style.display = 'none'
      return
    }
    this.thumb.style.display = ''
    const rawH = (clientHeight / scrollHeight) * railH
    const thumbH = this._drag ? this._drag.thumbH : Math.max(rawH, this.opts.minThumb)
    const travel = railH - thumbH
    const maxScroll = scrollHeight - clientHeight
    const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0
    this.thumb.style.height = `${thumbH}px`
    this.thumb.style.transform = `translateY(${travel * ratio}px)`
  }

  // ---- internals --------------------------------------------------------

  _bindScroll() {
    const onScroll = () => {
      this.update()
      this._markScrolling()
    }
    this.content.addEventListener('scroll', onScroll)
    this._disposers.push(() => this.content.removeEventListener('scroll', onScroll))
  }

  _bindResizeAndMutation() {
    // Content growth (appended messages, streaming token deltas) doesn't
    // fire `scroll`. Observe the subtree so the thumb follows scrollHeight.
    const mo = new MutationObserver(() => this.update())
    mo.observe(this.content, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(() => this.update())
    ro.observe(this.content)
    ro.observe(this.root)
    this._disposers.push(() => mo.disconnect(), () => ro.disconnect())
  }

  _bindThumbDrag() {
    // Global move/up listeners are only attached for the duration of a
    // drag — idle instances don't participate in every mouse event.
    const onMove = (e) => {
      if (!this._drag) return
      // Re-read rail rect each tick: the container may resize while we
      // drag (window resize, splitter drag). thumbH is captured at
      // mousedown since it can't change during a drag.
      const railRect = this.rail.getBoundingClientRect()
      const travel = railRect.height - this._drag.thumbH
      if (travel <= 0) return
      const y = e.clientY - railRect.top - this._drag.pointerOffsetInThumb
      const clamped = Math.max(0, Math.min(travel, y))
      const ratio = clamped / travel
      const maxScroll = this.content.scrollHeight - this.content.clientHeight
      this.content.scrollTop = ratio * maxScroll
    }
    const onUp = () => {
      if (!this._drag) return
      this._drag = null
      this.rail.classList.remove('active')
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Thumb height was frozen at the drag's cached thumbH; now that the
      // drag is over, let it re-resolve to the true content ratio.
      this.update()
    }
    const onDown = (e) => {
      e.preventDefault()
      const thumbRect = this.thumb.getBoundingClientRect()
      this._drag = {
        pointerOffsetInThumb: e.clientY - thumbRect.top,
        thumbH: thumbRect.height,
      }
      this.rail.classList.add('active')
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
    this.thumb.addEventListener('mousedown', onDown)
    this._disposers.push(
      () => this.thumb.removeEventListener('mousedown', onDown),
      // If destroy() fires mid-drag, the onUp handler above isn't called
      // — strip the global listeners explicitly so they can't leak.
      () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      },
    )
  }

  _bindRailPaging() {
    const onDown = (e) => {
      // `e.target === rail` excludes clicks on the thumb, so paging and
      // thumb drags don't collide.
      if (e.target !== this.rail) return
      // No-scroll state: thumb is display:none, so its bounding rect is
      // all zeros and the paging math degenerates. Nothing to page to.
      if (this.thumb.style.display === 'none') return
      const railRect = this.rail.getBoundingClientRect()
      const thumbRect = this.thumb.getBoundingClientRect()
      const clickY = e.clientY - railRect.top
      const thumbTop = thumbRect.top - railRect.top
      const delta = this.content.clientHeight * this.opts.pageRatio
      this.content.scrollTop += clickY < thumbTop ? -delta : delta
    }
    this.rail.addEventListener('mousedown', onDown)
    this._disposers.push(() => this.rail.removeEventListener('mousedown', onDown))
  }

  _markScrolling() {
    this.rail.classList.add('scrolling')
    if (this._idleTimer) clearTimeout(this._idleTimer)
    this._idleTimer = setTimeout(() => {
      this.rail.classList.remove('scrolling')
      this._idleTimer = null
    }, this.opts.idleMs)
  }
}
