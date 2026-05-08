import { useRef } from 'react'
import { useChatStore } from '#/renderer/stores/chat.ts'

/**
 * Terminal-style prompt history navigation.
 *
 * `historyIdx === null` means the textarea shows the live draft;
 * otherwise it points at userHistory[idx] counted from the most-recent
 * end. We snapshot the live draft on first walk-back so ArrowDown past
 * index 0 restores exactly what the user was typing.
 */
export function usePromptHistory(
  text: string,
  setText: (next: string) => void,
  setPendingCaret: (pos: number) => void,
): {
  navigate: (direction: -1 | 1) => void
  resetToDraft: () => void
} {
  const historyIdxRef = useRef<number | null>(null)
  const freshDraftRef = useRef<string>('')

  function navigate(direction: -1 | 1): void {
    const userHistory = useChatStore
      .getState()
      .nodes.filter((n): n is Extract<typeof n, { kind: 'user' }> => n.kind === 'user')
      .map((n) => n.text)
    if (userHistory.length === 0) return

    const cur = historyIdxRef.current
    let nextIdx: number | null
    if (direction === -1) {
      // Walk back into history. First step from "live draft" stashes
      // it for the eventual return trip.
      if (cur === null) freshDraftRef.current = text
      nextIdx = cur === null ? userHistory.length - 1 : Math.max(0, cur - 1)
    } else {
      if (cur === null) return
      nextIdx = cur + 1 >= userHistory.length ? null : cur + 1
    }
    historyIdxRef.current = nextIdx
    const newText = nextIdx === null ? freshDraftRef.current : userHistory[nextIdx]
    setPendingCaret(newText.length)
    setText(newText)
  }

  function resetToDraft() {
    historyIdxRef.current = null
  }

  return { navigate, resetToDraft }
}
