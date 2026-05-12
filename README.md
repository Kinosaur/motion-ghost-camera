# Motion Ghost

A camera that only reveals movement.

---

## What it does

Motion Ghost uses your webcam to detect motion in real time and renders it as three distinct visual effects — all processed locally in-browser, nothing ever leaves your device.

| Mode | Effect |
|------|--------|
| **Ghost** | Motion pixels glow with colour temperature — cold blue for slow movement, warm gold for fast. Chromatic aberration splits at high intensity. |
| **Web** | A full constellation fills the screen. Your body is a dark void cut through it. Move and the web heals behind you. |
| **Rain** | Rain falls from the top. Your body blocks it — drops glow where they land on your silhouette. |

## Controls

- **Sensitivity** — how strongly the camera reacts to movement
- **Trail** — how long effects persist (Ghost: ghost fade · Web: shadow linger · Rain: rain density)
- **Exit** — return to landing screen

## Stack

- [Next.js](https://nextjs.org) 15 (App Router)
- TypeScript
- Tailwind CSS
- HTML5 Canvas 2D — no WebGL, no third-party rendering libraries

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and allow camera access when prompted.

## Privacy

All motion detection and rendering happens entirely in-browser. No video data is transmitted or stored anywhere.
