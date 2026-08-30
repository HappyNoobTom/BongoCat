import { median, medianAbsoluteDeviation } from 'simple-statistics'

export type RhythmIntensity = 'light' | 'normal' | 'strong'

export interface RhythmDetectorOptions {
  /** 0.5 is less sensitive, 2 is more sensitive. */
  sensitivity: number
  minIntervalMs: number
  strongThreshold: number
  silenceThresholdDb: number
  historyMs?: number
}

export interface RhythmHit {
  intensity: RhythmIntensity
  score: number
  levelDb: number
  timestamp: number
}

export interface RhythmSample {
  levelDb: number
  normalizedLevel: number
  rise: number
  threshold: number
}

const DEFAULT_OPTIONS: RhythmDetectorOptions = {
  sensitivity: 1,
  minIntervalMs: 120,
  strongThreshold: 2.1,
  silenceThresholdDb: -55,
  historyMs: 2000,
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Turns the coarse level values exposed by OBS into a stable stream of
 * one-shot accents. It intentionally detects onsets instead of pretending
 * that a 20Hz level meter contains a full audio spectrum.
 */
export class RhythmDetector {
  private options: RhythmDetectorOptions = { ...DEFAULT_OPTIONS }
  private history: Array<{ timestamp: number, rise: number }> = []
  private fast = 0
  private slow = 0
  private previousRise = 0
  private lastHitAt = -Infinity
  private initialized = false
  private armed = true

  constructor(options: Partial<RhythmDetectorOptions> = {}) {
    this.updateOptions(options)
  }

  updateOptions(options: Partial<RhythmDetectorOptions>) {
    this.options = {
      ...this.options,
      ...options,
      sensitivity: clamp(options.sensitivity ?? this.options.sensitivity, 0.5, 2),
      minIntervalMs: clamp(options.minIntervalMs ?? this.options.minIntervalMs, 60, 500),
      strongThreshold: clamp(options.strongThreshold ?? this.options.strongThreshold, 1.4, 4),
      silenceThresholdDb: clamp(options.silenceThresholdDb ?? this.options.silenceThresholdDb, -90, -20),
      historyMs: clamp(options.historyMs ?? this.options.historyMs ?? 2000, 500, 5000),
    }
  }

  reset() {
    this.history = []
    this.fast = 0
    this.slow = 0
    this.previousRise = 0
    this.lastHitAt = -Infinity
    this.initialized = false
    this.armed = true
  }

  getSample(levelDb: number, timestamp = Date.now()): RhythmSample {
    const safeLevelDb = Number.isFinite(levelDb) ? levelDb : -100
    const normalizedLevel = clamp(
      (safeLevelDb - this.options.silenceThresholdDb) / (0 - this.options.silenceThresholdDb),
      0,
      1,
    )

    if (!this.initialized) {
      this.fast = normalizedLevel
      this.slow = normalizedLevel
      this.initialized = true
    } else {
      // The fast envelope follows attacks; the slow envelope describes the
      // recent bed of the track. Their positive difference is an onset score.
      this.fast += (normalizedLevel - this.fast) * 0.58
      this.slow += (normalizedLevel - this.slow) * 0.08
    }

    const rise = Math.max(0, this.fast - this.slow)

    this.history.push({ timestamp, rise })
    const cutoff = timestamp - (this.options.historyMs ?? 2000)

    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift()
    }

    const rises = this.history.map(item => item.rise)
    const baseline = rises.length > 1 ? median(rises) : 0
    const deviation = rises.length > 5 ? medianAbsoluteDeviation(rises) : 0.012
    const sensitivityFactor = 1.75 / this.options.sensitivity
    const threshold = Math.max(0.025, baseline + sensitivityFactor * Math.max(deviation, 0.012))

    return {
      levelDb: safeLevelDb,
      normalizedLevel,
      rise,
      threshold,
    }
  }

  process(levelDb: number, timestamp = Date.now()): RhythmHit | undefined {
    return this.processSample(this.getSample(levelDb, timestamp), timestamp)
  }

  processSample(sample: RhythmSample, timestamp = Date.now()): RhythmHit | undefined {
    const { rise, threshold } = sample

    // Re-arm only after the current accent has decayed. This prevents a loud
    // sustained note from generating a stream of artificial key presses.
    if (!this.armed && rise <= threshold * 0.55) {
      this.armed = true
    }

    const warm = this.history.length >= 8
    const isCandidate = warm
      && this.armed
      && sample.levelDb >= this.options.silenceThresholdDb
      && rise >= threshold
      && rise >= this.previousRise
      && timestamp - this.lastHitAt >= this.options.minIntervalMs

    this.previousRise = rise

    if (!isCandidate) return

    this.lastHitAt = timestamp
    this.armed = false

    const ratio = rise / Math.max(threshold, 0.001)
    const intensity: RhythmIntensity = ratio >= this.options.strongThreshold
      ? 'strong'
      : ratio >= 1.35 ? 'normal' : 'light'

    return {
      intensity,
      score: clamp((ratio - 1) / Math.max(this.options.strongThreshold - 1, 0.5), 0, 1),
      levelDb: sample.levelDb,
      timestamp,
    }
  }
}

export function getLevelDbFromMeters(inputLevelsMul: unknown): number {
  if (!Array.isArray(inputLevelsMul) || inputLevelsMul.length === 0) return -100

  const channelLevels = inputLevelsMul
    .map((channel) => {
      if (Array.isArray(channel)) {
        // OBS exposes [VU, post-fader peak, pre-fader peak] per channel.
        const postFader = Number(channel[1] ?? channel[0])
        return Number.isFinite(postFader) ? Math.max(0, postFader) : 0
      }

      const value = Number(channel)
      return Number.isFinite(value) ? Math.max(0, value) : 0
    })
    .filter(value => value > 0)

  if (channelLevels.length === 0) return -100

  const rms = Math.sqrt(channelLevels.reduce((sum, value) => sum + value ** 2, 0) / channelLevels.length)

  return rms > 0 ? 20 * Math.log10(rms) : -100
}
