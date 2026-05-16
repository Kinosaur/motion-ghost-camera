# Motion Ghost — v3.1

A camera that reveals only movement.

---

## What it does

Motion Ghost uses your webcam (or an uploaded video file) to detect motion in real time and renders it as two distinct visual effects — processed entirely in-browser. Nothing ever leaves your device.

| Mode | Effect |
|------|--------|
| **Trace** | Motion pixels accumulate as a persistent luminous trail. Still areas stay black; movement burns white. A chromatic aberration pass intensifies across the full canvas proportional to local motion. |
| **Rain** | Pixel rain falls continuously from the top of the frame. Your silhouette blocks it — drops freeze with a brief horizontal splash on impact, then respawn. |

---

## Controls

**Trace mode**
- **Sensitivity** — motion detection threshold (how strongly the camera reacts to movement)
- **Trail** — how long the trace persists (fade rate of accumulated pixels)

**Rain mode**
- **Sensitivity** — motion detection threshold
- **Amount** — rain density (30–240 simultaneous drops)
- **Trail** — fall speed

**Both modes**
- Auto-hiding controls panel (3.5 s timeout, revealed on any interaction)
- **Exit** — return to landing screen

**Video file mode**

Upload a video from the landing screen (max 90 seconds). The pipeline plays the file through once at real-time speed — WebGL renders the effect live as a preview — while `MediaRecorder` captures the canvas to MP4. After the pass:

- The processed MP4 auto-plays and loops with a 1-second black screen between cycles
- A **Download MP4** button appears in the controls panel
- The scrubber and play/pause control the captured video

Controls are locked during the processing pass to prevent interference.

---

## Stack

- [Next.js](https://nextjs.org) 16 (App Router)
- TypeScript
- Tailwind CSS
- **WebGL2** — GPU-accelerated rendering via GLSL ES 3.00 shaders; no third-party rendering libraries

---

## Architecture

**Motion detection** runs on the CPU via Canvas 2D at 320×180. A running-average background subtraction model (`BG_LEARN = 0.05`) adapts each frame — camera noise and slow lighting drift are absorbed; genuine movement stands out clearly.

**Trace** uses ping-pong framebuffers to accumulate a persistent trail texture. Each frame: fade the previous texture → composite new motion point sprites → chromatic aberration post-process pass over the full canvas.

**Rain** is a column simulation in JavaScript: each drop has a random x position (not a grid), a speed multiplier for natural variation, and a body-hit timer. Drops are uploaded as a vertex buffer each frame and rendered as `gl.POINTS` (3×3 px square sprites). No ping-pong FBO — canvas is cleared and redrawn each frame.

**Video capture** uses `canvas.captureStream(30)` fed into `MediaRecorder`. H.264 MP4 (`avc1.42E01E`) is requested first; the browser falls back to VP9 WebM if MP4 encoding is unavailable. The output blob is held in memory as a `blob:` URL — no server, no upload.

---

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and allow camera access when prompted.

---

## Credits

Trace mode inspired by the work of [Anna Zhang](https://github.com/anna-zhang).

---

## Privacy

All motion detection and rendering happens entirely in-browser. No video data is transmitted or stored anywhere.
