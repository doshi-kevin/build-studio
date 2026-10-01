// Camera config test page — lets professors (and devs) test and tune
// phone detection and face detection models in real-time.

import { CameraConfigTest } from '@/components/professor/camera-test/CameraConfigTest'

export default function CameraTestPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px]">
          Camera Detection Test
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Test and tune phone detection and face detection models in real-time.
        </p>
      </div>
      <CameraConfigTest />
    </div>
  )
}
