/**
 * Serialize async tasks onto a single tail so concurrent callers
 * observe a strict happens-before ordering. Used for read-modify-write
 * cycles against on-disk JSON (settings, secrets, recents): without
 * serialization, two callers each read the old map, splice their own
 * field, and the second writer's `rename` overwrites the first's
 * contribution.
 *
 * Errors don't sink the tail — each task's `.catch` keeps the chain
 * resolvable so one failed write doesn't poison every subsequent call.
 * Callers still receive the original rejection on their own returned
 * promise.
 */
export function createSerialQueue(): {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>
} {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    enqueue: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn)
      tail = next.catch(() => {})
      return next
    },
  }
}
