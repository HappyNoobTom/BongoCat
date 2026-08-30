import FFT from 'fft.js'
import { median, medianAbsoluteDeviation } from 'simple-statistics'

export type SpectrumBand = 'low' | 'mid' | 'high'
export type SpectrumIntensity = 'light' | 'normal' | 'strong'

export interface SpectrumAnalyzerOptions {
  sampleRate?: number
  channels?: number
  fftSize?: number
  hopSize?: number
  minIntervalMs?: number
  sensitivity?: number
  includeSpectrum?: boolean
}

export interface SpectrumBands {
  lowDb: number
  midDb: number
  highDb: number
  lowRiseDb: number
  midRiseDb: number
  highRiseDb: number
  lowFlux: number
  midFlux: number
  highFlux: number
}

export interface SpectrumBeat {
  band: SpectrumBand
  intensity: SpectrumIntensity
  score: number
  levelDb: number
  timestamp: number
  bpm?: number
}

export interface SpectrumFrame {
  timestamp: number
  levelDb: number
  normalizedLevel: number
  bands: SpectrumBands
  spectrum?: number[]
  beat?: SpectrumBeat
  bpm?: number
}

const DEFAULT_OPTIONS: Required<SpectrumAnalyzerOptions> = {
  sampleRate: 48_000,
  channels: 1,
  fftSize: 2048,
  hopSize: 512,
  minIntervalMs: 220,
  sensitivity: 1,
  includeSpectrum: true,
}

const MIN_DB = -100
const HISTORY_MS = 2200
const MIN_WARM_FRAMES = 20
const FLUX_FLOOR = 0.006
const LOW_ENERGY_RISE_DB = 0.35
const MID_ENERGY_RISE_DB = 0.5
const SPECTRUM_BINS = 64
const SPECTRUM_MIN_HZ = 30
const SPECTRUM_MAX_HZ = 10_000

const BAND_RANGES: Record<SpectrumBand, readonly [number, number]> = {
  low: [30, 180],
  mid: [180, 2500],
  high: [2500, 10_000],
}

const BAND_ORDER: readonly SpectrumBand[] = ['low', 'mid', 'high']
// Cymbals and codec hiss can create a large amount of bin-to-bin movement;
// keep high-frequency flux available for visualisation but do not let it drive
// the keyboard by default. Kicks and snares are covered by low + mid.
const DETECTION_BANDS: readonly SpectrumBand[] = ['low', 'mid']

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function dbFromAmplitude(amplitude: number) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : MIN_DB
}

interface PendingFrame {
  timestamp: number
  levelDb: number
  bands: SpectrumBands
}

interface BandHistory {
  values: Array<{ timestamp: number, value: number }>
  lastHitAt: number
}

/**
 * Online onset detector for FFT band flux.
 *
 * The detector deliberately emits only one global event when several bands
 * rise together (for example a kick with a snare attack). Each band keeps its
 * own robust baseline, then the strongest eligible band wins. This prevents a
 * single transient from producing three keyboard actions.
 */
class SpectrumOnsetDetector {
  private readonly history: Record<SpectrumBand, BandHistory> = {
    low: { values: [], lastHitAt: -Infinity },
    mid: { values: [], lastHitAt: -Infinity },
    high: { values: [], lastHitAt: -Infinity },
  }

  private readonly pending: PendingFrame[] = []
  private readonly minIntervalMs: number
  private readonly sensitivity: number
  private lastHitAt = -Infinity
  private lastLowBeatAt = -Infinity
  private readonly lowIntervals: number[] = []
  private bpm = 0

  constructor(options: Pick<SpectrumAnalyzerOptions, 'minIntervalMs' | 'sensitivity'>) {
    this.minIntervalMs = clamp(options.minIntervalMs ?? DEFAULT_OPTIONS.minIntervalMs, 120, 600)
    this.sensitivity = clamp(options.sensitivity ?? DEFAULT_OPTIONS.sensitivity, 0.5, 2)
  }

  reset() {
    for (const band of BAND_ORDER) {
      this.history[band].values = []
      this.history[band].lastHitAt = -Infinity
    }
    this.pending.length = 0
    this.lastHitAt = -Infinity
    this.lastLowBeatAt = -Infinity
    this.lowIntervals.length = 0
    this.bpm = 0
  }

  process(frame: PendingFrame): SpectrumBeat | undefined {
    this.pending.push(frame)
    this.addToHistory(frame)

    if (this.pending.length < 3) return

    const previous = this.pending[0]
    const center = this.pending[1]
    const next = this.pending[2]
    this.pending.shift()

    const candidates = DETECTION_BANDS
      .map((band) => {
        const value = center.bands[`${band}Flux`]
        const previousValue = previous.bands[`${band}Flux`]
        const nextValue = next.bands[`${band}Flux`]
        const state = this.history[band]
        const threshold = this.getThreshold(state.values)
        const prominence = value - Math.min(previousValue, nextValue)
        const riseDb = center.bands[`${band}RiseDb`]
        const minimumRiseDb = band === 'low' ? LOW_ENERGY_RISE_DB : MID_ENERGY_RISE_DB
        const localMaximum = value >= previousValue
          && value >= nextValue
          && prominence >= FLUX_FLOOR * 0.25
        const energyRise = riseDb >= minimumRiseDb
        const warm = state.values.length >= MIN_WARM_FRAMES
        const eligible = warm
          && localMaximum
          && energyRise
          && value >= threshold
          && value >= FLUX_FLOOR
          && center.timestamp - state.lastHitAt >= this.minIntervalMs

        return { band, value, threshold, eligible }
      })
      .filter(candidate => candidate.eligible)
      .sort((a, b) => b.value / b.threshold - a.value / a.threshold)

    const candidate = candidates[0]
    if (!candidate || center.timestamp - this.lastHitAt < this.minIntervalMs) return

    this.lastHitAt = center.timestamp
    this.history[candidate.band].lastHitAt = center.timestamp

    let nextBpm = this.bpm
    if (candidate.band === 'low') nextBpm = this.recordLowBeat(center.timestamp)

    const ratio = candidate.value / Math.max(candidate.threshold, FLUX_FLOOR)
    const intensity: SpectrumIntensity = ratio >= 2.4
      ? 'strong'
      : ratio >= 1.45 ? 'normal' : 'light'

    return {
      band: candidate.band,
      intensity,
      score: clamp((ratio - 1) / 1.4, 0, 1),
      levelDb: center.levelDb,
      timestamp: center.timestamp,
      bpm: nextBpm > 0 ? nextBpm : undefined,
    }
  }

  getBpm() {
    return this.bpm > 0 ? this.bpm : undefined
  }

  private addToHistory(frame: PendingFrame) {
    for (const band of BAND_ORDER) {
      const values = this.history[band].values
      values.push({
        timestamp: frame.timestamp,
        value: frame.bands[`${band}Flux`],
      })
      const cutoff = frame.timestamp - HISTORY_MS
      while (values.length > 0 && values[0].timestamp < cutoff) values.shift()
    }
  }

  private getThreshold(values: Array<{ timestamp: number, value: number }>) {
    if (values.length < 2) return FLUX_FLOOR

    const fluxes = values.map(item => item.value)
    const baseline = median(fluxes)
    const deviation = values.length > 5 ? medianAbsoluteDeviation(fluxes) : FLUX_FLOOR / 2
    const adaptive = baseline + (1.8 / this.sensitivity) * Math.max(deviation, FLUX_FLOOR / 2)
    return Math.max(FLUX_FLOOR, adaptive)
  }

  private recordLowBeat(timestamp: number) {
    if (this.lastLowBeatAt !== -Infinity) {
      const interval = timestamp - this.lastLowBeatAt
      if (interval >= 300 && interval <= 1500) {
        this.lowIntervals.push(interval)
        if (this.lowIntervals.length > 8) this.lowIntervals.shift()
        const sorted = [...this.lowIntervals].sort((a, b) => a - b)
        const middle = Math.floor(sorted.length / 2)
        const medianInterval = sorted.length % 2 === 0
          ? (sorted[middle - 1] + sorted[middle]) / 2
          : sorted[middle]
        const candidateBpm = 60_000 / medianInterval
        this.bpm = this.bpm > 0 ? this.bpm * 0.7 + candidateBpm * 0.3 : candidateBpm
      }
    }
    this.lastLowBeatAt = timestamp
    return this.bpm
  }
}

/**
 * Converts raw little-endian signed PCM16 into low/mid/high FFT bands and
 * online spectral-flux onsets. It is intentionally independent from OBS so
 * the same analyzer can consume a WASAPI loopback release or a test fixture.
 */
export class SpectrumAnalyzer {
  private readonly options: Required<SpectrumAnalyzerOptions>
  private readonly fft: FFT
  private readonly window: Float64Array
  private readonly fftInput: Float64Array
  private readonly fftOutput: any[]
  private readonly previousLogMagnitudes: Float64Array
  private readonly spectrumBinByFftBin: Int16Array
  private samples: Float64Array
  private sampleCount = 0
  private frameStartSample = 0
  private streamStartTimestamp?: number
  private hasPreviousSpectrum = false
  private readonly onset: SpectrumOnsetDetector
  private previousBandDb: Record<SpectrumBand, number> = { low: MIN_DB, mid: MIN_DB, high: MIN_DB }
  private hasPreviousBandDb = false

  constructor(options: SpectrumAnalyzerOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      sampleRate: Math.max(8_000, Math.round(options.sampleRate ?? DEFAULT_OPTIONS.sampleRate)),
      channels: Math.max(1, Math.round(options.channels ?? DEFAULT_OPTIONS.channels)),
      fftSize: options.fftSize ?? DEFAULT_OPTIONS.fftSize,
      hopSize: options.hopSize ?? DEFAULT_OPTIONS.hopSize,
      minIntervalMs: clamp(options.minIntervalMs ?? DEFAULT_OPTIONS.minIntervalMs, 120, 600),
      sensitivity: clamp(options.sensitivity ?? DEFAULT_OPTIONS.sensitivity, 0.5, 2),
      includeSpectrum: options.includeSpectrum ?? DEFAULT_OPTIONS.includeSpectrum,
    }

    if (this.options.fftSize < 256 || (this.options.fftSize & (this.options.fftSize - 1)) !== 0) {
      throw new Error('FFT 大小必须是 256 以上的 2 的幂')
    }
    if (this.options.hopSize < 1 || this.options.hopSize > this.options.fftSize) {
      throw new Error('FFT hop size 必须在 1 到 fftSize 之间')
    }

    this.fft = new FFT(this.options.fftSize)
    this.window = new Float64Array(this.options.fftSize)
    this.fftInput = new Float64Array(this.options.fftSize)
    this.fftOutput = this.fft.createComplexArray()
    this.previousLogMagnitudes = new Float64Array(this.options.fftSize / 2 + 1)
    this.samples = new Float64Array(this.options.fftSize * 2)
    this.spectrumBinByFftBin = this.createSpectrumBinMap()
    this.onset = new SpectrumOnsetDetector(this.options)

    for (let index = 0; index < this.window.length; index += 1) {
      this.window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (this.window.length - 1))
    }
  }

  reset() {
    this.samples.fill(0)
    this.sampleCount = 0
    this.frameStartSample = 0
    this.streamStartTimestamp = undefined
    this.previousLogMagnitudes.fill(0)
    this.hasPreviousSpectrum = false
    this.previousBandDb = { low: MIN_DB, mid: MIN_DB, high: MIN_DB }
    this.hasPreviousBandDb = false
    this.onset.reset()
  }

  /**
   * Feed one or more interleaved PCM16 frames. Buffer boundaries do not need
   * to line up with FFT frames; incomplete samples are ignored until the next
   * call by the bridge's PCM remainder buffer.
   */
  processPcm(buffer: Uint8Array, timestamp = Date.now()): SpectrumFrame[] {
    const bytesPerFrame = this.options.channels * 2
    const usableBytes = buffer.byteLength - (buffer.byteLength % bytesPerFrame)
    const frameCount = usableBytes / bytesPerFrame
    if (frameCount <= 0) return []

    if (this.streamStartTimestamp === undefined) {
      this.streamStartTimestamp = timestamp - (frameCount / this.options.sampleRate) * 1000
    }

    this.ensureCapacity(this.sampleCount + frameCount)
    let offset = 0
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0
      for (let channel = 0; channel < this.options.channels; channel += 1) {
        sum += this.readInt16LE(buffer, offset)
        offset += 2
      }
      this.samples[this.sampleCount] = sum / this.options.channels / 32_768
      this.sampleCount += 1
    }

    const frames: SpectrumFrame[] = []
    while (this.sampleCount >= this.options.fftSize) {
      const frameTimestamp = this.streamStartTimestamp
        + ((this.frameStartSample + this.options.fftSize / 2) / this.options.sampleRate) * 1000
      frames.push(this.analyzeFrame(frameTimestamp))

      this.frameStartSample += this.options.hopSize
      this.sampleCount -= this.options.hopSize
      this.samples.copyWithin(0, this.options.hopSize, this.options.hopSize + this.sampleCount)
    }

    return frames
  }

  private analyzeFrame(timestamp: number): SpectrumFrame {
    const halfSize = this.options.fftSize / 2
    const binHz = this.options.sampleRate / this.options.fftSize
    const bandPower: Record<SpectrumBand, number> = { low: 0, mid: 0, high: 0 }
    const bandCount: Record<SpectrumBand, number> = { low: 0, mid: 0, high: 0 }
    const bandFlux: Record<SpectrumBand, number> = { low: 0, mid: 0, high: 0 }
    const spectrumPower = this.options.includeSpectrum ? new Float64Array(SPECTRUM_BINS) : undefined
    const spectrumCount = this.options.includeSpectrum ? new Uint16Array(SPECTRUM_BINS) : undefined

    for (let index = 0; index < this.options.fftSize; index += 1) {
      this.fftInput[index] = this.samples[index] * this.window[index]
    }
    this.fft.realTransform(this.fftOutput, this.fftInput)

    for (let bin = 1; bin <= halfSize; bin += 1) {
      const frequency = bin * binHz
      const real = Number(this.fftOutput[bin * 2] || 0)
      const imaginary = bin === halfSize ? 0 : Number(this.fftOutput[bin * 2 + 1] || 0)
      const amplitude = Math.hypot(real, imaginary) * 2 / this.options.fftSize
      const power = amplitude ** 2
      const logMagnitude = Math.log1p(amplitude * 1_000)
      const previous = this.previousLogMagnitudes[bin]
      const flux = this.hasPreviousSpectrum ? Math.max(0, logMagnitude - previous) : 0
      this.previousLogMagnitudes[bin] = logMagnitude

      const band = this.getBand(frequency)
      if (band) {
        bandPower[band] += power
        bandCount[band] += 1
        bandFlux[band] += flux
      }

      if (spectrumPower && spectrumCount && frequency >= SPECTRUM_MIN_HZ && frequency <= SPECTRUM_MAX_HZ) {
        const spectrumBin = this.spectrumBinByFftBin[bin]
        if (spectrumBin >= 0) {
          spectrumPower[spectrumBin] += power
          spectrumCount[spectrumBin] += 1
        }
      }
    }
    this.hasPreviousSpectrum = true

    const lowDb = dbFromAmplitude(Math.sqrt(bandPower.low / Math.max(1, bandCount.low)))
    const midDb = dbFromAmplitude(Math.sqrt(bandPower.mid / Math.max(1, bandCount.mid)))
    const highDb = dbFromAmplitude(Math.sqrt(bandPower.high / Math.max(1, bandCount.high)))
    const lowFlux = bandFlux.low / Math.max(1, bandCount.low)
    const midFlux = bandFlux.mid / Math.max(1, bandCount.mid)
    const highFlux = bandFlux.high / Math.max(1, bandCount.high)
    const levelDb = Math.max(lowDb, midDb, highDb)
    const bands: SpectrumBands = {
      lowDb,
      midDb,
      highDb,
      lowRiseDb: this.hasPreviousBandDb ? lowDb - this.previousBandDb.low : 0,
      midRiseDb: this.hasPreviousBandDb ? midDb - this.previousBandDb.mid : 0,
      highRiseDb: this.hasPreviousBandDb ? highDb - this.previousBandDb.high : 0,
      lowFlux,
      midFlux,
      highFlux,
    }
    this.previousBandDb = { low: lowDb, mid: midDb, high: highDb }
    this.hasPreviousBandDb = true
    const beat = this.onset.process({ timestamp, levelDb, bands })
    const bpm = beat?.bpm || this.onset.getBpm()

    return {
      timestamp,
      levelDb,
      normalizedLevel: clamp((levelDb + 70) / 70, 0, 1),
      bands,
      spectrum: spectrumPower && spectrumCount
        ? Array.from(spectrumPower, (power, index) => dbFromAmplitude(Math.sqrt(power / Math.max(1, spectrumCount[index]))))
        : undefined,
      beat,
      bpm,
    }
  }

  private getBand(frequency: number): SpectrumBand | undefined {
    for (const band of BAND_ORDER) {
      const [low, high] = BAND_RANGES[band]
      if (frequency >= low && frequency < high) return band
    }
    return undefined
  }

  private createSpectrumBinMap() {
    const map = new Int16Array(this.options.fftSize / 2 + 1)
    map.fill(-1)
    const logMin = Math.log(SPECTRUM_MIN_HZ)
    const logSpan = Math.log(SPECTRUM_MAX_HZ) - logMin
    const binHz = this.options.sampleRate / this.options.fftSize

    for (let bin = 1; bin <= this.options.fftSize / 2; bin += 1) {
      const frequency = bin * binHz
      if (frequency < SPECTRUM_MIN_HZ || frequency > SPECTRUM_MAX_HZ) continue
      map[bin] = clamp(
        Math.floor(((Math.log(frequency) - logMin) / logSpan) * SPECTRUM_BINS),
        0,
        SPECTRUM_BINS - 1,
      )
    }
    return map
  }

  private ensureCapacity(required: number) {
    if (required <= this.samples.length) return
    let capacity = this.samples.length
    while (capacity < required) capacity *= 2
    const next = new Float64Array(capacity)
    next.set(this.samples.subarray(0, this.sampleCount))
    this.samples = next
  }

  private readInt16LE(buffer: Uint8Array, offset: number) {
    const value = buffer[offset] | (buffer[offset + 1] << 8)
    return value & 0x8000 ? value - 0x1_0000 : value
  }
}

export function getSpectrumBandLabel(band: SpectrumBand) {
  return band === 'low' ? '低频' : band === 'mid' ? '中频' : '高频'
}
