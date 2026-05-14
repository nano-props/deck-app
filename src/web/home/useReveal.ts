// Once-only IntersectionObserver hook. Mirrors the vanilla
// `docs/index.html` reveal-on-scroll: 12% threshold, -40px bottom
// rootMargin, unobserve on first hit.
//
// Returns a ref to attach to the element you want to fade in. Pair
// with the `.reveal` / `.reveal.on` CSS in `home.css`.

import { useEffect, useRef } from 'react'

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Reduced-motion users get the final state immediately — saves
    // setting up the observer at all on devices that opted out.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('on')
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            ;(e.target as HTMLElement).classList.add('on')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}
