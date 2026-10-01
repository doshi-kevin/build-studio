// Client-side video proctoring module using face-api.js and COCO-SSD.
// Runs face detection every 4s, phone detection every 8s.
// Detects: multiple faces and phone in frame.
// Captures JPEG snapshots only on violations. Integrates with ProctoringCapture batch system.

import type { ProctoringEvent } from '@/lib/validations/proctoring'
import { logger } from '@/lib/logger'

const DETECTION_INTERVAL_MS = 4_000       // face detection interval
const PHONE_DETECTION_INTERVAL_MS = 8_000 // phone detection interval (heavier model)
const SNAPSHOT_COOLDOWN_MS = 10_000       // min time between snapshots per violation type
const SNAPSHOT_WIDTH = 320
const SNAPSHOT_HEIGHT = 240
const SNAPSHOT_QUALITY = 0.6

// Detection thresholds (defaults)
const DEFAULT_PHONE_CONFIDENCE = 0.60     // COCO-SSD confidence threshold

export type ViolationType = 'mf' | 'ph' | 'bl'

export interface VideoProctoringOptions {
  attemptStartedAt: string
  getCurrentQuestionIndex: () => number
  onViolation: (event: ProctoringEvent) => void
  onSnapshot: (
    blob: Blob,
    violationType: ViolationType,
    timestampOffset: number,
    questionIndex: number,
    faceCount: number,
  ) => void
  detectionIntervalMs?: number
  phoneConfidenceThreshold?: number
}

// Dynamic import types
type FaceApiModule = typeof import('@vladmandic/face-api')
type CocoSsdModel = { detect: (input: HTMLVideoElement) => Promise<Array<{ class: string; score: number }>> }

export class VideoProctoring {
  private videoElement: HTMLVideoElement | null = null
  private canvasElement: HTMLCanvasElement | null = null
  private stream: MediaStream | null = null
  private detectionInterval: ReturnType<typeof setInterval> | null = null
  private phoneDetectionInterval: ReturnType<typeof setInterval> | null = null
  private faceApi: FaceApiModule | null = null
  private cocoModel: CocoSsdModel | null = null
  private modelsLoaded = false
  private cocoLoaded = false
  private started = false
  private options: VideoProctoringOptions

  // Face tracking state
  private detecting = false
  private detectingPhone = false
  private lastKnownFaceCount = 0

  // Snapshot cooldown per violation type
  private lastSnapshotTime: Record<string, number> = {}

  // Timing
  private startTime: number
  private intervalMs: number

  constructor(options: VideoProctoringOptions) {
    this.options = options
    this.startTime = new Date(options.attemptStartedAt).getTime()
    this.intervalMs = options.detectionIntervalMs ?? DETECTION_INTERVAL_MS
  }

  /** Load all detection models. Face models are required; COCO-SSD is best-effort. */
  async loadModels(): Promise<boolean> {
    try {
      // Phase 1: Face detection (required for multi-face detection)
      this.faceApi = await import('@vladmandic/face-api')
      await this.faceApi.nets.tinyFaceDetector.loadFromUri('/models/face-api')
      this.modelsLoaded = true
      logger.info('[SCHOLERA INFO] Face detection model loaded')

      // Phase 2: COCO-SSD for phone detection (optional, best-effort)
      // TF.js backend must be initialized before COCO-SSD can load/detect
      try {
        const tf = await import('@tensorflow/tfjs')
        await tf.ready()
        logger.info(`[SCHOLERA INFO] TF.js backend ready: ${tf.getBackend()}`)

        const cocoSsd = await import('@tensorflow-models/coco-ssd')
        this.cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' })
        this.cocoLoaded = true
        logger.info('[SCHOLERA INFO] COCO-SSD model loaded — phone detection enabled')
      } catch (cocoErr) {
        logger.warn('[SCHOLERA WARN] COCO-SSD load failed — phone detection disabled', { error: String(cocoErr) })
      }

      return true
    } catch (err) {
      logger.error('[SCHOLERA ERROR] Failed to load face detection models', err)
      this.modelsLoaded = false
      return false
    }
  }

  /** Start detection with a media stream. */
  async start(
    videoEl: HTMLVideoElement,
    canvasEl: HTMLCanvasElement,
    stream: MediaStream,
  ): Promise<void> {
    if (this.started || !this.modelsLoaded || !this.faceApi) return

    this.videoElement = videoEl
    this.canvasElement = canvasEl
    this.stream = stream

    videoEl.srcObject = stream
    videoEl.muted = true
    await videoEl.play()

    this.started = true

    // Capture a baseline snapshot after a short delay (proves camera was active)
    setTimeout(() => this._captureBaseline(), 2000)

    // Main detection interval: face counting
    this.detectionInterval = setInterval(() => this.detect(), this.intervalMs)

    // Separate phone detection interval (heavier, runs less frequently)
    if (this.cocoLoaded && this.cocoModel) {
      this.phoneDetectionInterval = setInterval(
        () => this.detectPhone(),
        PHONE_DETECTION_INTERVAL_MS,
      )
    }

    logger.info('[SCHOLERA INFO] Video proctoring started')
  }

  /** Stop detection and release resources. */
  stop() {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval)
      this.detectionInterval = null
    }
    if (this.phoneDetectionInterval) {
      clearInterval(this.phoneDetectionInterval)
      this.phoneDetectionInterval = null
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }

    this.started = false
    this.videoElement = null
    this.canvasElement = null
    logger.info('[SCHOLERA INFO] Video proctoring stopped')
  }

  get isActive(): boolean {
    return this.started
  }

  get violationCount(): number {
    return Object.keys(this.lastSnapshotTime).length > 0
      ? Object.values(this.lastSnapshotTime).filter((t) => t > 0).length
      : 0
  }

  // ── Private: Baseline Snapshot ─────────────────────────────────

  private _captureBaseline() {
    if (!this.started || !this.videoElement || !this.canvasElement) return
    if (this.videoElement.readyState < 2) return

    const offset = this._offset()
    const qi = this.options.getCurrentQuestionIndex()
    this._captureSnapshot('bl', offset, qi, 0)
    logger.info('[SCHOLERA INFO] Baseline snapshot captured')
  }

  // ── Private: Face Detection ─────────────────────────────────────

  private async detect(): Promise<void> {
    if (this.detecting || !this.faceApi || !this.videoElement || !this.started) return
    if (this.videoElement.readyState < 2) return

    this.detecting = true

    try {
      const detections = await this.faceApi
        .detectAllFaces(
          this.videoElement,
          new this.faceApi.TinyFaceDetectorOptions({
            inputSize: 224,
            scoreThreshold: 0.5,
          }),
        )

      const faceCount = detections.length
      this.lastKnownFaceCount = faceCount
      const offset = this._offset()
      const qi = this.options.getCurrentQuestionIndex()

      // Only flag multiple faces
      if (faceCount > 1) {
        this._emitViolation('mf', offset, qi, faceCount)
      }
    } catch (err) {
      logger.warn('[SCHOLERA WARN] Face detection error', { error: err })
    } finally {
      this.detecting = false
    }
  }

  // ── Private: Phone Detection (COCO-SSD) ────────────────────────

  private async detectPhone(): Promise<void> {
    if (this.detectingPhone || !this.cocoModel || !this.videoElement || !this.started) return
    if (this.videoElement.readyState < 2) return

    this.detectingPhone = true

    try {
      const predictions = await this.cocoModel.detect(this.videoElement)
      const threshold = this.options.phoneConfidenceThreshold ?? DEFAULT_PHONE_CONFIDENCE

      const phoneDetected = predictions.some(
        (p) => p.class === 'cell phone' && p.score >= threshold,
      )

      if (phoneDetected) {
        const offset = this._offset()
        const qi = this.options.getCurrentQuestionIndex()
        this._emitViolation('ph', offset, qi, this.lastKnownFaceCount)
      }
    } catch (err) {
      logger.warn('[SCHOLERA WARN] Phone detection error', { error: err })
    } finally {
      this.detectingPhone = false
    }
  }

  // ── Private: Violation Emission + Snapshots ────────────────────

  private _emitViolation(
    type: ViolationType,
    offset: number,
    qi: number,
    faceCount: number,
  ) {
    const event: ProctoringEvent = { t: offset, type, qi, fc: faceCount }
    this.options.onViolation(event)

    if (this._shouldSnapshot(type)) {
      this.lastSnapshotTime[type] = Date.now()
      this._captureSnapshot(type, offset, qi, faceCount)
    }
  }

  private _shouldSnapshot(violationType: string): boolean {
    const lastTime = this.lastSnapshotTime[violationType] ?? 0
    return Date.now() - lastTime >= SNAPSHOT_COOLDOWN_MS
  }

  private _captureSnapshot(
    violationType: ViolationType,
    offset: number,
    qi: number,
    faceCount: number,
  ) {
    if (!this.videoElement || !this.canvasElement) return

    const canvas = this.canvasElement
    canvas.width = SNAPSHOT_WIDTH
    canvas.height = SNAPSHOT_HEIGHT

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(this.videoElement, 0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)

    canvas.toBlob(
      (blob) => {
        if (blob) {
          this.options.onSnapshot(blob, violationType, offset, qi, faceCount)
        }
      },
      'image/jpeg',
      SNAPSHOT_QUALITY,
    )
  }

  private _offset(): number {
    return Math.max(0, Date.now() - this.startTime)
  }
}
