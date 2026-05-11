// Mirror a reactive value into a ref so non-reactive callers (effects
// with `[]` deps, async tasks, registry callbacks) can read its
// current value without re-binding. Common case: a flusher registered
// once on mount that needs to read the user's current form state at
// teardown — capturing the state directly closes over its mount-time
// value forever.
//
// The assignment runs on every render, *not* in useEffect, so the ref
// is current the moment React commits — an effect that fires on the
// same commit (or any later render) sees the latest value. (useEffect
// would mirror one render late, breaking the contract for any caller
// that reads inside a synchronous handler kicked off by the same
// render that just changed the value.)

import { useRef } from 'react'

export function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}
