import assert from 'node:assert/strict'

import { getLevelDbFromMeters, RhythmDetector } from '../src/services/rhythmDetector.ts'

assert.equal(
  getLevelDbFromMeters([[0.1, 0.5, 0.5], [0.1, 0.5, 0.5]]),
  20 * Math.log10(0.5),
)
assert.equal(getLevelDbFromMeters([]), -100)
assert.equal(getLevelDbFromMeters(undefined), -100)

const detector = new RhythmDetector({ minIntervalMs: 100 })
let timestamp = 0
const hits = []

// Warm the adaptive baseline, then feed three clear onsets.
for (let index = 0; index < 10; index += 1) {
  timestamp += 50
  detector.process(-25, timestamp)
}

for (const levelDb of [-25, -25, -8, -25, -25, -7, -25, -25, -6]) {
  timestamp += 50
  const hit = detector.process(levelDb, timestamp)

  if (hit) hits.push(hit)
}

assert.ok(hits.length >= 2, 'clear level onsets should produce rhythm hits')
assert.ok(hits.some(hit => hit.intensity === 'strong'), 'a large onset should be classified as strong')

const sustained = new RhythmDetector()
let sustainedHits = 0

for (let index = 0; index < 40; index += 1) {
  if (sustained.process(-10, index * 50)) sustainedHits += 1
}

assert.equal(sustainedHits, 0, 'a sustained level should not retrigger continuously')
assert.equal(new RhythmDetector().process(-100, 0), undefined)

console.log(`Rhythm detector checks passed (${hits.length} onset hits).`)
