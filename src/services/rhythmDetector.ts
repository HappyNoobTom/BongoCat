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

interface TimedSample extends RhythmSample {
  timestamp: number
}

const DEFAULT_OPTIONS: RhythmDetectorOptions = {
  sensitivity: 1,
  minIntervalMs: 90,
  strongThreshold: 2.1,
  silenceThresholdDb: -80,
  historyMs: 1800,
}

const SAMPLE_INTERVAL_MS = 50
const PEAK_WINDOW_SIZE = 3
const MIN_WARM_SAMPLES = 8
const MIN_DETECT_INTERVAL_MS = 70
const SILENCE_RESET_MS = 300
// With OBS' 50 ms meter samples, a one-decibel musical accent can be quite
// small after RMS integration. Keep the floor below that so quiet kick/snare
// hits are not discarded before the adaptive threshold gets a chance to work.
const MIN_RISE = 0.005

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Turns the coarse level values exposed by OBS into stable one-shot accents.
 *
 * OBS sends three multipliers per channel: magnitude (RMS-ish), post-fader
 * peak, and pre-fader peak. The detector uses magnitude as the main signal,
 * with attenuated peak contributions so short attacks remain visible without
 * letting OBS' peak hold create a beat on every meter update.
 */
export class RhythmDetector {
  private options: RhythmDetectorOptions = { ...DEFAULT_OPTIONS }
  private history: Array<{ timestamp: number, rise: number }> = []
  private pending: TimedSample[] = []
  private fast = 0
  private slow = 0
  private lastHitAt = -Infinity
  private lastSampleAt = 0
  private silentSince = -Infinity
  private initialized = false

  constructor(options: Partial<RhythmDetectorOptions> = {}) {
    this.updateOptions(options)
  }

  updateOptions(options: Partial<RhythmDetectorOptions>) {
    this.options = {
      ...this.options,
      ...options,
      sensitivity: clamp(options.sensitivity ?? this.options.sensitivity, 0.5, 2),
      minIntervalMs: clamp(options.minIntervalMs ?? this.options.minIntervalMs, MIN_DETECT_INTERVAL_MS, 500),
      strongThreshold: clamp(options.strongThreshold ?? this.options.strongThreshold, 1.4, 4),
      silenceThresholdDb: clamp(options.silenceThresholdDb ?? this.options.silenceThresholdDb, -100, -20),
      historyMs: clamp(options.historyMs ?? this.options.historyMs ?? 2400, 800, 5000),
    }
  }

  reset() {
    this.history = []
    this.pending = []
    this.fast = 0
    this.slow = 0
    this.lastHitAt = -Infinity
    this.lastSampleAt = 0
    this.silentSince = -Infinity
    this.initialized = false
  }

  private getMinRise() {
    // Sensitivity lowers the adaptive threshold, but not this absolute noise
    // gate. Otherwise turning sensitivity up would turn ordinary meter jitter
    // into a stream of phantom beats.
    return MIN_RISE
  }

  private getThreshold() {
    const rises = this.history.map(item => item.rise)
    const baseline = rises.length > 1 ? median(rises) : 0
    const deviation = rises.length > 5 ? medianAbsoluteDeviation(rises) : 0.0035
    const adaptive = baseline + (0.9 / this.options.sensitivity) * Math.max(deviation, 0.0035)

    return Math.max(this.getMinRise(), adaptive)
  }

  getSample(levelDb: number, timestamp = Date.now()): RhythmSample {
    const safeLevelDb = Number.isFinite(levelDb) ? levelDb : -100
    const range = Math.max(1, 0 - this.options.silenceThresholdDb)
    const normalizedLevel = clamp(
      (safeLevelDb - this.options.silenceThresholdDb) / range,
      0,
      1,
    )

    if (safeLevelDb < this.options.silenceThresholdDb) {
      if (this.silentSince === -Infinity) this.silentSince = timestamp

      if (timestamp - this.silentSince >= SILENCE_RESET_MS) {
        this.history = []
        this.pending = []
        this.fast = normalizedLevel
        this.slow = normalizedLevel
        this.lastHitAt = -Infinity
      }
    } else {
      this.silentSince = -Infinity
    }

    const elapsed = this.lastSampleAt > 0
      ? clamp(timestamp - this.lastSampleAt, SAMPLE_INTERVAL_MS * 0.5, SAMPLE_INTERVAL_MS * 3)
      : SAMPLE_INTERVAL_MS
    const timeScale = elapsed / SAMPLE_INTERVAL_MS
    const previousFast = this.fast

    if (!this.initialized) {
      this.fast = normalizedLevel
      this.slow = normalizedLevel
      this.initialized = true
    } else {
      // The fast envelope follows attacks; the slow envelope describes the
      // recent bed of the track. Their positive difference is onset strength.
      const fastAlpha = 1 - (1 - 0.68) ** timeScale
      const slowAlpha = 1 - (1 - 0.08) ** timeScale
      this.fast += (normalizedLevel - this.fast) * fastAlpha
      this.slow += (normalizedLevel - this.slow) * slowAlpha
    }

    this.lastSampleAt = timestamp
    const attack = Math.max(0, this.fast - previousFast)
    const contrast = Math.max(0, this.fast - this.slow)
    // Positive envelope movement reacts to a new kick/snare, while a small
    // contrast component keeps slower musical accents visible after OBS'
    // 50 ms meter integration.
    const rise = attack * 0.75 + contrast * 0.25
    this.history.push({ timestamp, rise })

    const cutoff = timestamp - (this.options.historyMs ?? 2400)
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift()
    }

    return {
      levelDb: safeLevelDb,
      normalizedLevel,
      rise,
      threshold: this.getThreshold(),
    }
  }

  process(levelDb: number, timestamp = Date.now()): RhythmHit | undefined {
    return this.processSample(this.getSample(levelDb, timestamp), timestamp)
  }

  processSample(sample: RhythmSample, timestamp = Date.now()): RhythmHit | undefined {
    this.pending.push({ ...sample, timestamp })

    // Peak-picking with one sample of look-ahead avoids firing on the rising
    // edge of a sound and makes the visual action line up with the local peak.
    if (this.pending.length < PEAK_WINDOW_SIZE) return

    const previous = this.pending[0]
    const center = this.pending[1]
    const next = this.pending[2]
    this.pending.shift()

    const prominence = center.rise - Math.min(previous.rise, next.rise)
    const localMaximum = center.rise >= previous.rise
      && center.rise >= next.rise
      && prominence >= this.getMinRise() * 0.45
    const warm = this.history.length >= MIN_WARM_SAMPLES
    const isCandidate = warm
      && localMaximum
      && center.levelDb >= this.options.silenceThresholdDb
      && center.rise >= center.threshold
      && center.rise >= this.getMinRise()
      && center.timestamp - this.lastHitAt >= this.options.minIntervalMs

    if (!isCandidate) return

    this.lastHitAt = center.timestamp
    const ratio = center.rise / Math.max(center.threshold, this.getMinRise())
    const intensity: RhythmIntensity = ratio >= this.options.strongThreshold
      ? 'strong'
      : ratio >= 1.35 ? 'normal' : 'light'

    return {
      intensity,
      score: clamp((ratio - 1) / Math.max(this.options.strongThreshold - 1, 0.5), 0, 1),
      levelDb: center.levelDb,
      timestamp: center.timestamp,
    }
  }
}

function rms(values: number[]) {
  if (values.length === 0) return 0

  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length)
}

export function getLevelDbFromMeters(inputLevelsMul: unknown): number {
  if (!Array.isArray(inputLevelsMul) || inputLevelsMul.length === 0) return -100

  const magnitudes: number[] = []
  const peaks: number[] = []
  const inputPeaks: number[] = []

  for (const channel of inputLevelsMul) {
    if (!Array.isArray(channel)) {
      const value = Number(channel)
      if (Number.isFinite(value) && value > 0) magnitudes.push(value)
      continue
    }

    const magnitude = Number(channel[0])
    const peak = Number(channel[1])
    const inputPeak = Number(channel[2])

    if (Number.isFinite(magnitude) && magnitude > 0) magnitudes.push(magnitude)
    if (Number.isFinite(peak) && peak > 0) peaks.push(peak)
    if (Number.isFinite(inputPeak) && inputPeak > 0) inputPeaks.push(inputPeak)
  }

  const magnitudeRms = rms(magnitudes)
  const peakRms = rms(peaks)
  const inputPeakRms = rms(inputPeaks)
  const levelMul = Math.max(magnitudeRms, peakRms * 0.2, inputPeakRms * 0.1)

  return levelMul > 0 ? 20 * Math.log10(levelMul) : -100
}
