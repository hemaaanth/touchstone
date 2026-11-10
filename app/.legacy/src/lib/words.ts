import { useSyncExternalStore } from "react"

/*
 * Plain or Technical words (decision 11, critic note A7).
 * Plain is the default. The choice is saved in localStorage and shared by
 * every component through one small store.
 */

export type Words = "plain" | "technical"

const STORAGE_KEY = "rth.words"
const listeners = new Set<() => void>()

function readSaved(): Words {
  try {
    return localStorage.getItem(STORAGE_KEY) === "technical" ? "technical" : "plain"
  } catch {
    return "plain"
  }
}

let current: Words = readSaved()

export function setWords(next: Words) {
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage can be blocked. Keep the choice for this page only.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Picks the plain or the technical text. */
export function pick<T>(words: Words, plain: T, technical: T): T {
  return words === "technical" ? technical : plain
}

/**
 * The current words and a picker.
 * Example: const { pick } = useWords(); pick(step.plain, step.technical)
 */
export function useWords() {
  const words = useSyncExternalStore(subscribe, () => current, () => "plain" as Words)
  return {
    words,
    technical: words === "technical",
    setWords,
    toggle: () => setWords(words === "technical" ? "plain" : "technical"),
    pick: <T,>(plain: T, technical: T) => pick(words, plain, technical),
  }
}
