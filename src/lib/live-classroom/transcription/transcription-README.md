# Transcription Folder

Real-time speech transcription for the live classroom using ElevenLabs Scribe v2.

| File | Purpose |
|------|---------|
| `types.ts` | Shared types, constants, and WebSocket message interfaces for Scribe v2 |
| `use-transcription.ts` | Core hook: microphone → AudioWorklet → WebSocket → debounced DB append |
| `use-voice-activity.ts` | Lightweight voice activity detection via AnalyserNode for UI indicator |
