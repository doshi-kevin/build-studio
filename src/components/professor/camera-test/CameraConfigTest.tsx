// Real-time camera detection test component. Shows a live video feed with
// phone detection (COCO-SSD) and face detection (face-api.js) overlays.
// Lets you tune confidence thresholds and detection intervals live.

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Camera, CameraOff, Loader2, Smartphone, Users, Settings2, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { logger } from '@/lib/logger'

// ── Types for dynamic imports ───────────────────────────────
type FaceApiModule = typeof import('@vladmandic/face-api')
type CocoSsdModel = {
  detect: (input: HTMLVideoElement) => Promise<
    Array<{ class: string; score: number; bbox: [number, number, number, number] }>
  >
}

interface DetectionLog {
  id: number
  time: string
  type: 'phone' | 'face' | 'info' | 'error'
  message: string
}

export function CameraConfigTest() {
  // Camera state
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsReady, setModelsReady] = useState(false)

  // Detection config (tunable)
  const [phoneConfidence, setPhoneConfidence] = useState(0.6)
  const [faceScoreThreshold, setFaceScoreThreshold] = useState(0.5)
  const [faceInputSize, setFaceInputSize] = useState(224)
  const [phoneIntervalMs, setPhoneIntervalMs] = useState(2000)
  const [faceIntervalMs, setFaceIntervalMs] = useState(2000)

  // Live detection results
  const [faceCount, setFaceCount] = useState(0)
  const [phoneDetected, setPhoneDetected] = useState(false)
  const [phoneScore, setPhoneScore] = useState(0)
  const [allDetections, setAllDetections] = useState<Array<{ class: string; score: number }>>([])
  const [logs, setLogs] = useState<DetectionLog[]>([])
  const logIdRef = useRef(0)

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const faceApiRef = useRef<FaceApiModule | null>(null)
  const cocoModelRef = useRef<CocoSsdModel | null>(null)
  const faceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phoneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const detectingFaceRef = useRef(false)
  const detectingPhoneRef = useRef(false)

  // Config refs (so intervals can read latest values)
  const phoneConfRef = useRef(phoneConfidence)
  const faceScoreRef = useRef(faceScoreThreshold)
  const faceInputRef = useRef(faceInputSize)
  useEffect(() => { phoneConfRef.current = phoneConfidence }, [phoneConfidence])
  useEffect(() => { faceScoreRef.current = faceScoreThreshold }, [faceScoreThreshold])
  useEffect(() => { faceInputRef.current = faceInputSize }, [faceInputSize])

  const addLog = useCallback((type: DetectionLog['type'], message: string) => {
    const id = ++logIdRef.current
    const time = new Date().toLocaleTimeString()
    setLogs((prev) => [{ id, time, type, message }, ...prev].slice(0, 100))
  }, [])

  // ── Load models ──────────────────────────────────────────────

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    addLog('info', 'Loading detection models...')

    try {
      // Face detection
      const faceApi = await import('@vladmandic/face-api')
      await faceApi.nets.tinyFaceDetector.loadFromUri('/models/face-api')
      faceApiRef.current = faceApi
      addLog('info', 'Face detection model loaded (TinyFaceDetector)')

      // COCO-SSD for phone detection
      try {
        const tf = await import('@tensorflow/tfjs')
        await tf.ready()
        addLog('info', `TF.js backend ready: ${tf.getBackend()}`)

        const cocoSsd = await import('@tensorflow-models/coco-ssd')
        const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' })
        cocoModelRef.current = model
        addLog('info', 'COCO-SSD model loaded (lite_mobilenet_v2) — phone detection ready')
      } catch (err) {
        addLog('error', `COCO-SSD failed to load: ${err}`)
      }

      setModelsReady(true)
      addLog('info', 'All models ready')
    } catch (err) {
      addLog('error', `Model loading failed: ${err}`)
      logger.error('[SCHOLERA ERROR] Camera test model load failed', err)
    } finally {
      setModelsLoading(false)
    }
  }, [addLog])

  // ── Start camera ────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    setCameraError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      })
      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      setCameraActive(true)
      addLog('info', 'Camera started')

      // Load models if not loaded yet
      if (!modelsReady) {
        await loadModels()
      }
    } catch (err) {
      setCameraError(String(err))
      addLog('error', `Camera access failed: ${err}`)
    }
  }, [modelsReady, loadModels, addLog])

  // ── Stop camera ─────────────────────────────────────────────

  const stopCamera = useCallback(() => {
    if (faceIntervalRef.current) { clearInterval(faceIntervalRef.current); faceIntervalRef.current = null }
    if (phoneIntervalRef.current) { clearInterval(phoneIntervalRef.current); phoneIntervalRef.current = null }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    setCameraActive(false)
    setFaceCount(0)
    setPhoneDetected(false)
    setPhoneScore(0)
    setAllDetections([])
    addLog('info', 'Camera stopped')
  }, [addLog])

  // ── Face detection loop ─────────────────────────────────────

  const runFaceDetection = useCallback(async () => {
    if (detectingFaceRef.current || !faceApiRef.current || !videoRef.current) return
    if (videoRef.current.readyState < 2) return

    detectingFaceRef.current = true
    try {
      const detections = await faceApiRef.current.detectAllFaces(
        videoRef.current,
        new faceApiRef.current.TinyFaceDetectorOptions({
          inputSize: faceInputRef.current,
          scoreThreshold: faceScoreRef.current,
        }),
      )
      const count = detections.length
      setFaceCount(count)

      if (count > 1) {
        addLog('face', `Multiple faces detected: ${count}`)
      }
    } catch (err) {
      addLog('error', `Face detection error: ${err}`)
    } finally {
      detectingFaceRef.current = false
    }
  }, [addLog])

  // ── Phone detection loop ────────────────────────────────────

  const runPhoneDetection = useCallback(async () => {
    if (detectingPhoneRef.current || !cocoModelRef.current || !videoRef.current) return
    if (videoRef.current.readyState < 2) return

    detectingPhoneRef.current = true
    try {
      const predictions = await cocoModelRef.current.detect(videoRef.current)
      setAllDetections(predictions.map((p) => ({ class: p.class, score: p.score })))

      const phone = predictions.find(
        (p) => p.class === 'cell phone' && p.score >= phoneConfRef.current,
      )

      setPhoneDetected(!!phone)
      setPhoneScore(phone?.score ?? 0)

      if (phone) {
        addLog('phone', `Phone detected! Confidence: ${(phone.score * 100).toFixed(1)}%`)
      }

      // Draw bounding boxes on canvas
      if (canvasRef.current && videoRef.current) {
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        if (ctx) {
          canvas.width = videoRef.current.videoWidth || 640
          canvas.height = videoRef.current.videoHeight || 480
          ctx.clearRect(0, 0, canvas.width, canvas.height)

          for (const pred of predictions) {
            const [x, y, w, h] = pred.bbox
            const isPhone = pred.class === 'cell phone' && pred.score >= phoneConfRef.current

            ctx.strokeStyle = isPhone ? '#ef4444' : '#3b82f6'
            ctx.lineWidth = 2
            ctx.strokeRect(x, y, w, h)

            ctx.fillStyle = isPhone ? '#ef4444' : '#3b82f6'
            ctx.font = '12px sans-serif'
            ctx.fillText(
              `${pred.class} (${(pred.score * 100).toFixed(0)}%)`,
              x,
              y > 15 ? y - 5 : y + h + 15,
            )
          }
        }
      }
    } catch (err) {
      addLog('error', `Phone detection error: ${err}`)
    } finally {
      detectingPhoneRef.current = false
    }
  }, [addLog])

  // ── Start/restart detection intervals when config or camera changes ──

  useEffect(() => {
    if (!cameraActive || !modelsReady) return

    // Clear existing
    if (faceIntervalRef.current) clearInterval(faceIntervalRef.current)
    if (phoneIntervalRef.current) clearInterval(phoneIntervalRef.current)

    // Start face detection
    if (faceApiRef.current) {
      runFaceDetection() // immediate first run
      faceIntervalRef.current = setInterval(runFaceDetection, faceIntervalMs)
    }

    // Start phone detection
    if (cocoModelRef.current) {
      runPhoneDetection() // immediate first run
      phoneIntervalRef.current = setInterval(runPhoneDetection, phoneIntervalMs)
    }

    return () => {
      if (faceIntervalRef.current) { clearInterval(faceIntervalRef.current); faceIntervalRef.current = null }
      if (phoneIntervalRef.current) { clearInterval(phoneIntervalRef.current); phoneIntervalRef.current = null }
    }
  }, [cameraActive, modelsReady, faceIntervalMs, phoneIntervalMs, runFaceDetection, runPhoneDetection])

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopCamera() }
  }, [stopCamera])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
      {/* Left: Video Feed */}
      <div className="space-y-4">
        <Card className="p-4 overflow-hidden">
          <div className="relative aspect-[4/3] bg-muted/30 rounded-xl overflow-hidden">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />

            {!cameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <div className="w-16 h-16 rounded-2xl border border-border bg-background flex items-center justify-center">
                  <Camera className="h-8 w-8 text-muted-foreground" />
                </div>
                <Button onClick={startCamera} disabled={modelsLoading} className="gap-2 rounded-full px-6">
                  {modelsLoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Loading Models...</>
                  ) : (
                    <><Camera className="h-4 w-4" /> Start Camera</>
                  )}
                </Button>
                {cameraError && (
                  <p className="text-xs text-destructive max-w-xs text-center">{cameraError}</p>
                )}
              </div>
            )}

            {/* Live status badges */}
            {cameraActive && (
              <div className="absolute top-3 left-3 flex gap-2">
                <Badge variant={faceCount === 1 ? 'default' : faceCount > 1 ? 'destructive' : 'secondary'} className="gap-1 text-xs">
                  <Users className="h-3 w-3" />
                  {faceCount} face{faceCount !== 1 ? 's' : ''}
                </Badge>
                {phoneDetected ? (
                  <Badge variant="destructive" className="gap-1 text-xs">
                    <Smartphone className="h-3 w-3" />
                    Phone ({(phoneScore * 100).toFixed(0)}%)
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <Smartphone className="h-3 w-3" />
                    No phone
                  </Badge>
                )}
              </div>
            )}
          </div>

          {cameraActive && (
            <div className="flex justify-between items-center mt-3">
              <Button variant="outline" size="sm" onClick={stopCamera} className="gap-1.5">
                <CameraOff className="h-3.5 w-3.5" />
                Stop Camera
              </Button>
              <Badge variant="outline" className="text-xs">
                {modelsReady ? 'Models loaded' : 'Models loading...'}
              </Badge>
            </div>
          )}
        </Card>

        {/* COCO-SSD raw detections */}
        {cameraActive && allDetections.length > 0 && (
          <Card className="p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-3">
              All COCO-SSD Detections
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {allDetections.map((d, i) => (
                <Badge
                  key={i}
                  variant={d.class === 'cell phone' ? 'destructive' : 'secondary'}
                  className="text-xs"
                >
                  {d.class} ({(d.score * 100).toFixed(1)}%)
                </Badge>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Right: Config Panel + Logs */}
      <div className="space-y-4">
        {/* Config */}
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Detection Config</h3>
          </div>

          <div className="space-y-4">
            {/* Phone confidence threshold */}
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                Phone Confidence Threshold
              </label>
              <div className="flex items-center gap-3 mt-1.5">
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={phoneConfidence}
                  onChange={(e) => setPhoneConfidence(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-mono w-12 text-right">{(phoneConfidence * 100).toFixed(0)}%</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Current production: 60%. Lower = more sensitive, higher = fewer false positives.
              </p>
            </div>

            <Separator />

            {/* Face score threshold */}
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                Face Score Threshold
              </label>
              <div className="flex items-center gap-3 mt-1.5">
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={faceScoreThreshold}
                  onChange={(e) => setFaceScoreThreshold(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-mono w-12 text-right">{(faceScoreThreshold * 100).toFixed(0)}%</span>
              </div>
            </div>

            {/* Face input size */}
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                Face Input Size
              </label>
              <div className="flex gap-2 mt-1.5">
                {[128, 160, 224, 320, 416].map((size) => (
                  <Button
                    key={size}
                    variant={faceInputSize === size ? 'default' : 'outline'}
                    size="sm"
                    className="text-xs px-2.5"
                    onClick={() => setFaceInputSize(size)}
                  >
                    {size}
                  </Button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Larger = more accurate but slower. Production: 224.
              </p>
            </div>

            <Separator />

            {/* Detection intervals */}
            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                Phone Detection Interval
              </label>
              <div className="flex items-center gap-3 mt-1.5">
                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={500}
                  value={phoneIntervalMs}
                  onChange={(e) => setPhoneIntervalMs(parseInt(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-mono w-16 text-right">{(phoneIntervalMs / 1000).toFixed(1)}s</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Production: 8s. Testing: 2s.</p>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
                Face Detection Interval
              </label>
              <div className="flex items-center gap-3 mt-1.5">
                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={500}
                  value={faceIntervalMs}
                  onChange={(e) => setFaceIntervalMs(parseInt(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-mono w-16 text-right">{(faceIntervalMs / 1000).toFixed(1)}s</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Production: 4s. Testing: 2s.</p>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 mt-2"
              onClick={() => {
                setPhoneConfidence(0.6)
                setFaceScoreThreshold(0.5)
                setFaceInputSize(224)
                setPhoneIntervalMs(2000)
                setFaceIntervalMs(2000)
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to Defaults
            </Button>
          </div>
        </Card>

        {/* Detection Logs */}
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Detection Log
            </h3>
            <Button variant="ghost" size="sm" className="text-xs h-6 px-2" onClick={() => setLogs([])}>
              Clear
            </Button>
          </div>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {logs.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No events yet</p>
            )}
            {logs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 text-xs">
                <span className="text-muted-foreground shrink-0 font-mono">{log.time}</span>
                <Badge
                  variant={log.type === 'error' ? 'destructive' : log.type === 'phone' ? 'destructive' : log.type === 'face' ? 'default' : 'secondary'}
                  className="text-[10px] px-1.5 py-0 shrink-0"
                >
                  {log.type}
                </Badge>
                <span className="text-muted-foreground">{log.message}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
