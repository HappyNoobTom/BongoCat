/**
 * Pick a random item while avoiding an immediate repeat when there is more
 * than one choice. The optional random function keeps the behavior easy to
 * test without changing the normal Math.random-based animation behavior.
 */
export function pickRandomItem<T>(
  items: readonly T[],
  previous?: T,
  random: () => number = Math.random,
): T | undefined {
  if (items.length === 0) return undefined

  const candidates = previous === undefined || items.length === 1
    ? items
    : items.filter(item => item !== previous)

  const rawIndex = Math.floor(random() * candidates.length)
  const index = Math.min(Math.max(rawIndex, 0), candidates.length - 1)

  return candidates[index]
}
