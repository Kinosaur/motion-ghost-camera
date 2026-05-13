# Changelog

All notable changes to Motion Ghost are documented here.

---

## [2.0.0] — 2026-05-13

### Breaking changes
- **Web mode removed.** The constellation "you are the hole" mode has been dropped entirely.

### Added
- **WebGL2 rendering pipeline.** All visual output now runs on the GPU via GLSL shaders. The analysis canvas (motion detection) remains Canvas 2D; the output canvas is WebGL2.
- **Ghost: ping-pong trail accumulation.** Trail texture is accumulated across frames using two framebuffers — fade and new motion are computed in a single shader pass per frame.
- **Ghost: full-screen chromatic aberration post-process.** Aberration is now a screen-space shader pass applied across the entire canvas proportional to local motion intensity, replacing the per-pixel offset approach.
- **Rain: GPU point-sprite rendering.** Each drop is drawn as a soft-glowing point sprite via `gl.POINTS` with per-fragment radial falloff. Head + tail rendered as separate points for the streak illusion.
- **Rain: 5× more drops.** Max simultaneous drops increased from 3,000 to 15,000.
- **Landing screen cursor spotlight.** Cursor-following radial gradient replaces the canvas mouse-trail animation.
- **Landing screen touch support.** `onPointerMove` replaces `onMouseMove` — works on mobile.
- **Custom cursor dot.** Native cursor hidden; a white dot tracks the pointer 1:1 on the landing screen.
- **Mode pills on landing screen.** Ghost and Rain mode names shown as interactive buttons that open the camera directly into that mode's context.
- **Live indicator pill.** Status indicator wrapped in a dark `backdrop-blur` pill — always readable over any canvas content.
- **Slider fill indicator.** Track fill left of thumb rendered via inline `linear-gradient` style, showing current value position at a glance.
- **Per-mode slider hints.** Small label below each slider name describes what the slider controls in the active mode.

### Changed
- Controls panel gradient strengthened (`from-black/95`).
- Mode selector active underline widened and animated on transition.
- Sensitivity and Trail slider tracks thickened to 3px; thumb increased to 18px.
- Privacy note updated: "All processing local · No data leaves your device".
- `package.json` version bumped to `2.0.0`, description and keywords updated.

### Removed
- Web mode (`VisualMode = 'web'`), constellation generation, body-mask void erasure, `constellationRef`, `CNode`/`CEdge` types, `WEB_NODES`, `WEB_LINK_NORM` constants.
- Recording feature (`MediaRecorder`, `startRecording`, `stopRecording`, `isRecording` state, `downloadUrl` state, record button, Save link, `MAX_REC_MS`).
- Canvas mouse-trail animation on landing screen (canvas element, `TrailPoint` type, rAF loop, `trailRef`).

---

## [1.0.0] — 2026-05-13

### Added
- Initial release with Ghost, Web, and Rain modes on Canvas 2D.
- Motion detection via frame differencing at 320×180.
- Body mask (80×45 grid) shared between Web and Rain modes.
- MediaRecorder-based `.webm` recording up to 30 seconds.
- Landing screen with Cormorant Garamond display font and mouse-trail canvas.
- Controls panel: mode selector, Sensitivity and Trail sliders, Record button, Exit button.
- Live/Rec indicator (top-left).
- Auto-hiding controls panel (3.5s timeout, revealed on interaction).
- Error screen for denied/missing camera.
