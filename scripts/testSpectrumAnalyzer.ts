import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { SpectrumAnalyzer } from '../src/services/spectrumAnalyzer.ts'

const sampleRate = 48_000
const seconds = 3
const pcm = Buffer.alloc(sampleRate * seconds * 2)

for (let sample = 0; sample < sampleRate * seconds; sample += 1) {
  const time = sample / sampleRate
  const beatStart = Math.floor(time * 2) / 2
  const inBurst = time - beatStart < 0.08
  const amplitude = inBurst ? 0.8 : 0.02
  const value = Math.round(amplitude * Math.sin(2 * Math.PI * 80 * time) * 32_767)
  pcm.writeInt16LE(value, sample * 2)
}

const analyzer = new SpectrumAnalyzer({ channels: 1, includeSpectrum: false })
const frames = []
for (let offset = 0; offset < pcm.length; offset += 4_800 * 2) {
  frames.push(...analyzer.processPcm(pcm.subarray(offset, offset + 4_800 * 2), offset / 2 / sampleRate * 1000))
}

const spectrumFrame = new SpectrumAnalyzer({ channels: 1 }).processPcm(pcm.subarray(0, 4_800 * 2), 0)[0]
assert.equal(spectrumFrame?.spectrum?.length, 64, 'FFT output should expose 64 log-spaced bins')

assert.ok(frames.length > 200, 'FFT should produce approximately 93 frames per second')
assert.ok(frames.some(frame => frame.bands.lowDb > frame.bands.midDb), '80Hz tone should land in low band')
assert.ok(frames.some(frame => frame.beat), 'periodic low-frequency transients should produce beats')
assert.ok(frames.filter(frame => frame.beat).length >= 4, 'several periodic transients should be detected')

const firstBeat = frames.find(frame => frame.beat)?.beat
assert.equal(firstBeat?.band, 'low')
const lastBeat = [...frames].reverse().find(frame => frame.beat)?.beat
assert.ok(lastBeat?.bpm && lastBeat.bpm > 100 && lastBeat.bpm < 140, 'regular low beats should settle near 120 BPM')

const sustained = new SpectrumAnalyzer({ channels: 1, includeSpectrum: false })
const tone = Buffer.alloc(sampleRate * 2 * 2)
for (let sample = 0; sample < sampleRate * 2; sample += 1) {
  tone.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 80 * sample / sampleRate) * 0.4 * 32_767), sample * 2)
}
let sustainedBeatCount = 0
const sustainedFrames = []
for (let offset = 0; offset < tone.length; offset += 4_800 * 2) {
  sustainedFrames.push(...sustained.processPcm(tone.subarray(offset, offset + 4_800 * 2), offset / 2 / sampleRate * 1000))
}
sustainedBeatCount = sustainedFrames.filter(frame => frame.beat).length
assert.equal(sustainedBeatCount, 0, 'a sustained tone should not retrigger repeatedly')

console.log(`Spectrum analyzer checks passed (${frames.filter(frame => frame.beat).length} beats).`)
