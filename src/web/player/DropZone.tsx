// The whole upload screen IS the drop target. Users can drop the file
// anywhere on the page; there's no inner card. The `.hover` state
// signals "yes, this whole space accepts the file" without the visual
// noise of a bordered box.

import { useRef, useState, type ReactNode } from 'react'
import { cn } from '#/web/lib/cn.ts'

interface DropZoneProps {
  onFile: (file: File) => void
  children: ReactNode
}

export function DropZone({ onFile, children }: DropZoneProps) {
  const [hover, setHover] = useState(false)
  // Track depth so a child element entering doesn't briefly fire
  // dragleave on the parent. Standard HTML5 dnd workaround.
  const depth = useRef(0)

  return (
    <main
      className={cn(
        'flex-1 flex items-center justify-center px-6 py-12 transition-colors duration-[160ms]',
        hover && 'bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]',
      )}
      aria-labelledby="hero-title"
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        setHover(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setHover(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        depth.current = 0
        setHover(false)
        const file = e.dataTransfer?.files?.[0]
        if (file) onFile(file)
      }}
    >
      <div className="w-full max-w-[560px] flex flex-col items-center">
        {children}
      </div>
    </main>
  )
}
