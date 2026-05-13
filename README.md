# Motion Ghost — v2

A camera that only reveals movement.

---

## What it does

Motion Ghost uses your webcam to detect motion in real time and renders it as two distinct visual effects — all processed locally in-browser, nothing ever leaves your device.

| Mode | Effect |
|------|--------|
| **Ghost** | Motion pixels glow with colour temperature — cold blue for slow movement, warm gold for fast. Full-screen chromatic aberration splits at high intensity. |
| **Rain** | Rain falls from the top of the screen. Your body blocks it — drops glow and bloom where they land on your silhouette. |

## Controls

- **Sensitivity** — how strongly the camera reacts to movement
- **Trail** — how long effects persist (Ghost: ghost fade · Rain: rain density)
- **Exit** — return to landing screen

## Stack

- [Next.js](https://nextjs.org) 16 (App Router)
- TypeScript
- Tailwind CSS
- **WebGL2** — GPU-accelerated rendering via GLSL shaders; no third-party rendering libraries

## Architecture

Motion detection runs on the CPU via Canvas 2D frame differencing at 320×180. The result is uploaded each frame as a single-channel WebGL texture and consumed by mode-specific shader programs on the GPU.

**Ghost** uses ping-pong framebuffers to accumulate a persistent trail texture, with a separate chromatic aberration post-process pass.

**Rain** simulates up to 15,000 drops in JavaScript and renders them as GPU point sprites with per-fragment soft glow.

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and allow camera access when prompted.

## Privacy

All motion detection and rendering happens entirely in-browser. No video data is transmitted or stored anywhere.
