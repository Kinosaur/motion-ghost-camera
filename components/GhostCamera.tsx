'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Controls from './Controls';

// ── Constants ─────────────────────────────────────────────────────────────────
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;
const MASK_W     = 80;
const MASK_H     = 45;
const BG_LEARN   = 0.05;
const COL_MAX    = 400;   // max columns ever allocated
const TRAIL_DOTS = 3;     // head + 2 fading dots
const TRAIL_GAP  = 2;     // px between trail dots
const HIT_FRAMES = 18;    // frames frozen after body impact

// ── Types ─────────────────────────────────────────────────────────────────────
export type ErrorType  = 'denied' | 'no-camera' | 'unsupported';
export type VisualMode = 'trace' | 'rain';

interface MotionPixel { px: number; py: number; intensity: number }

interface Column {
  xNorm:    number;  // [0,1] normalized x — random, persistent across frames
  x:        number;  // screen-x = xNorm * W, computed each frame
  headY:    number;  // leading pixel Y (moves down)
  speedVar: number;  // multiplier 0.7–1.3 — baked at spawn for natural variation
  hitTimer: number;  // >0 = frozen after hitting a body
  hitY:     number;  // Y where the impact happened
}

interface Props { onError: (t: ErrorType) => void; onStop: () => void; videoFile?: File }

// ── GLSL Shaders ──────────────────────────────────────────────────────────────

const V_QUAD = /* glsl */`#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Trace — fade trail
const F_TRACE_FADE = /* glsl */`#version 300 es
precision mediump float;
uniform sampler2D u_scene;
uniform float u_fade;
in vec2 v_uv;
out vec4 out_color;
void main(){ out_color = texture(u_scene, v_uv) * u_fade; }`;

// Gesture — sharp 3px hard circle, fixed brightness (all motion equal)
const V_TRACE_POINT = /* glsl */`#version 300 es
layout(location=0) in vec2  a_pos;
layout(location=1) in float a_intens;
out float v_intens;
uniform vec2 u_res;
void main(){
  v_intens = a_intens;
  vec2 ndc = vec2(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 3.0;
}`;

const F_TRACE_POINT = /* glsl */`#version 300 es
precision highp float;
in float v_intens;
out vec4 out_color;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  if(length(c) > 0.5) discard;
  out_color = vec4(vec3(0.70), 1.0);
}`;

// Memory feed — 5-tap blur of gesture texture, scaled way down; additive onto memory FBO
const F_MEMORY_FEED = /* glsl */`#version 300 es
precision mediump float;
uniform sampler2D u_gesture;
uniform vec2      u_texel;
in vec2 v_uv;
out vec4 out_color;
void main(){
  vec3 g =
    texture(u_gesture, v_uv).rgb                               * 0.50 +
    texture(u_gesture, v_uv + vec2( u_texel.x*2.0, 0.0)).rgb  * 0.125 +
    texture(u_gesture, v_uv + vec2(-u_texel.x*2.0, 0.0)).rgb  * 0.125 +
    texture(u_gesture, v_uv + vec2(0.0,  u_texel.y*2.0)).rgb  * 0.125 +
    texture(u_gesture, v_uv + vec2(0.0, -u_texel.y*2.0)).rgb  * 0.125;
  out_color = vec4(g * 0.007, 1.0);
}`;

// Composite — gesture (bright) + memory (dim ghost underneath) → screen
const F_COMPOSITE = /* glsl */`#version 300 es
precision mediump float;
uniform sampler2D u_gesture;
uniform sampler2D u_memory;
in vec2 v_uv;
out vec4 out_color;
void main(){
  vec3 g = texture(u_gesture, v_uv).rgb;
  vec3 m = texture(u_memory,  v_uv).rgb;
  out_color = vec4(min(g + m * 0.6, vec3(0.85)), 1.0);
}`;

// Pixel rain — square 3×3 point, brightness only
const V_PIX_RAIN = /* glsl */`#version 300 es
layout(location=0) in vec2  a_pos;
layout(location=1) in float a_bright;
out float v_bright;
uniform vec2 u_res;
void main(){
  v_bright = a_bright;
  vec2 ndc = vec2(a_pos.x/u_res.x*2.0-1.0, 1.0-a_pos.y/u_res.y*2.0);
  gl_Position  = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 3.0;
}`;

const F_PIX_RAIN = /* glsl */`#version 300 es
precision mediump float;
in float v_bright;
out vec4 out_color;
void main(){ out_color = vec4(vec3(v_bright), 1.0); }`;

// ── WebGL helpers ──────────────────────────────────────────────────────────────
function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile error');
  return s;
}

function createProg(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER,   vert));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? 'program link error');
  return p;
}

function createTex(gl: WebGL2RenderingContext, w: number, h: number,
  internal: number, fmt: number, type: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
  return t;
}

function createFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function GhostCamera({ onError, onStop, videoFile }: Props) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const analysisRef  = useRef<HTMLCanvasElement>(null);
  const bgRef        = useRef<Float32Array | null>(null);
  const rafRef       = useRef<number>(0);
  const streamRef    = useRef<MediaStream | null>(null);
  const hideTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeSwitched = useRef(false);

  const sensitivityRef = useRef(30);
  const trailRef       = useRef(50);
  const rainAmountRef  = useRef(65);
  const modeRef        = useRef<VisualMode>('trace');

  // Rain — column simulation state
  const colsRef     = useRef<Column[]>([]);
  const bodyMaskRef = useRef(new Float32Array(MASK_W * MASK_H));
  // x, y, brightness — 3 floats per pixel vertex
  const colVertRef  = useRef(new Float32Array(COL_MAX * 55 * 3));

  // Trace
  const traceVertRef = useRef(new Float32Array(ANALYSIS_W * ANALYSIS_H * 3));

  // Video processing pipeline refs
  const videoPhaseRef     = useRef<'processing' | 'playback'>('processing');
  const recorderRef       = useRef<MediaRecorder | null>(null);
  const playbackRef       = useRef<HTMLVideoElement>(null);
  const processedUrlRef   = useRef<string | null>(null);
  const pbRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sensitivity, setSensitivity] = useState(30);
  const [trailLength, setTrailLength] = useState(50);
  const [rainAmount,  setRainAmount]  = useState(65);
  const [mode, setMode]               = useState<VisualMode>('trace');
  const [controlsVisible, setControlsVisible] = useState(true);

  const [isPlaying, setIsPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);

  // Video processing pipeline
  const [videoPhase, setVideoPhase]           = useState<'processing' | 'playback'>('processing');
  const [processProgress, setProcessProgress] = useState(0);
  const [processedUrl, setProcessedUrl]       = useState<string | null>(null);
  const [videoTooLong, setVideoTooLong]       = useState(false);
  const [pbPlaying, setPbPlaying]             = useState(false);
  const [pbTime, setPbTime]                   = useState(0);
  const [pbDuration, setPbDuration]           = useState(0);
  const [pbBlackScreen, setPbBlackScreen]     = useState(false);

  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { trailRef.current       = trailLength; }, [trailLength]);
  useEffect(() => { rainAmountRef.current  = rainAmount;  }, [rainAmount]);
  useEffect(() => { modeRef.current        = mode;        }, [mode]);
  useEffect(() => { videoPhaseRef.current  = videoPhase;  }, [videoPhase]);

  useEffect(() => {
    colsRef.current      = [];
    bodyMaskRef.current.fill(0);
    bgRef.current        = null;
    modeSwitched.current = true;
  }, [mode]);

  // ── Controls auto-hide ─────────────────────────────────────────────────────
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);

  useEffect(() => {
    revealControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [revealControls]);

  const togglePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);

  const handleSeek = useCallback((time: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = time;
    bgRef.current = null;
  }, []);

  const handleDownload = useCallback(() => {
    const url = processedUrlRef.current;
    if (!url) return;
    const date = new Date().toISOString().split('T')[0];
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `motion-ghost-${date}.mp4`;
    a.click();
  }, []);

  const togglePbPlay = useCallback(() => {
    const pb = playbackRef.current;
    if (!pb) return;
    if (pb.paused) pb.play().catch(() => {}); else pb.pause();
  }, []);

  const handlePbSeek = useCallback((time: number) => {
    const pb = playbackRef.current;
    if (pb) pb.currentTime = time;
  }, []);

  const handlePbEnded = useCallback(() => {
    setPbBlackScreen(true);
    if (pbRestartTimerRef.current) clearTimeout(pbRestartTimerRef.current);
    pbRestartTimerRef.current = setTimeout(() => {
      setPbBlackScreen(false);
      const pb = playbackRef.current;
      if (pb) { pb.currentTime = 0; pb.play().catch(() => {}); }
    }, 1000);
  }, []);

  // ── Main effect ────────────────────────────────────────────────────────────
  useEffect(() => {
    const video   = videoRef.current!;
    const canvas  = canvasRef.current!;
    const aCanvas = analysisRef.current!;
    const aCtx    = aCanvas.getContext('2d', { willReadFrequently: true })!;

    aCanvas.width  = ANALYSIS_W;
    aCanvas.height = ANALYSIS_H;

    const glOrNull = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!glOrNull) { onError('unsupported'); return; }
    const gl = glOrNull;

    gl.enable(gl.BLEND);

    let traceFadeProg: WebGLProgram, tracePointProg: WebGLProgram,
        memFeedProg: WebGLProgram, compositeProg: WebGLProgram,
        pixRainProg: WebGLProgram;
    try {
      traceFadeProg  = createProg(gl, V_QUAD,        F_TRACE_FADE);
      tracePointProg = createProg(gl, V_TRACE_POINT, F_TRACE_POINT);
      memFeedProg    = createProg(gl, V_QUAD,        F_MEMORY_FEED);
      compositeProg  = createProg(gl, V_QUAD,        F_COMPOSITE);
      pixRainProg    = createProg(gl, V_PIX_RAIN,    F_PIX_RAIN);
    } catch (e) {
      console.error(e);
      onError('unsupported');
      return;
    }

    const uTraceFade  = { scene: gl.getUniformLocation(traceFadeProg,  'u_scene'), fade: gl.getUniformLocation(traceFadeProg, 'u_fade') };
    const uTracePoint = { res:   gl.getUniformLocation(tracePointProg, 'u_res') };
    const uMemFeed    = { gesture: gl.getUniformLocation(memFeedProg,  'u_gesture'), texel: gl.getUniformLocation(memFeedProg, 'u_texel') };
    const uComposite  = { gesture: gl.getUniformLocation(compositeProg,'u_gesture'), memory: gl.getUniformLocation(compositeProg,'u_memory') };
    const uPixRain    = { res:     gl.getUniformLocation(pixRainProg,  'u_res') };

    // Fullscreen quad VAO
    const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const quadVAO   = gl.createVertexArray()!;
    gl.bindVertexArray(quadVAO);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Trace point VAO (x, y, intensity)
    const TRACE_STRIDE = 3 * 4;
    const traceVAO = gl.createVertexArray()!;
    gl.bindVertexArray(traceVAO);
    const traceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, traceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, traceVertRef.current.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TRACE_STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, TRACE_STRIDE, 2*4);
    gl.bindVertexArray(null);

    // Pixel rain VAO (x, y, brightness — 3 floats)
    const COL_STRIDE = 3 * 4;
    const colVAO = gl.createVertexArray()!;
    gl.bindVertexArray(colVAO);
    const colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colVertRef.current.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, COL_STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, COL_STRIDE, 2*4);
    gl.bindVertexArray(null);

    // Two ping-pong pairs: gesture (fresh trail) + memory (ghost layer)
    const r = {
      gestureTexA: null as WebGLTexture | null,
      gestureTexB: null as WebGLTexture | null,
      gestureFBOA: null as WebGLFramebuffer | null,
      gestureFBOB: null as WebGLFramebuffer | null,
      gesturePing: false,
      memoryTexA:  null as WebGLTexture | null,
      memoryTexB:  null as WebGLTexture | null,
      memoryFBOA:  null as WebGLFramebuffer | null,
      memoryFBOB:  null as WebGLFramebuffer | null,
      memoryPing:  false,
    };

    const handleResize = () => resizeGL(window.innerWidth, window.innerHeight);

    function resizeGL(W: number, H: number) {
      canvas.width  = W;
      canvas.height = H;
      gl.viewport(0, 0, W, H);
      [r.gestureTexA, r.gestureTexB, r.memoryTexA, r.memoryTexB].forEach(t => t && gl.deleteTexture(t));
      [r.gestureFBOA, r.gestureFBOB, r.memoryFBOA, r.memoryFBOB].forEach(f => f && gl.deleteFramebuffer(f));
      r.gestureTexA = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.gestureTexB = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.gestureFBOA = createFBO(gl, r.gestureTexA);
      r.gestureFBOB = createFBO(gl, r.gestureTexB);
      r.memoryTexA  = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.memoryTexB  = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.memoryFBOA  = createFBO(gl, r.memoryTexA);
      r.memoryFBOB  = createFBO(gl, r.memoryTexB);
      r.gesturePing = false;
      r.memoryPing  = false;
    }
    resizeGL(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', handleResize);

    let aborted = false;

    // Background warmup — learn fast for first N frames, suppress all output
    let warmupFrames    = 0;
    const WARMUP        = 60;   // ~1s at 60fps — screen stays black, bg settles silently
    const BG_LEARN_FAST = 0.15; // 3× faster than normal during warmup

    // ── rAF loop ───────────────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      if (videoPhaseRef.current === 'playback') return;
      if (video.readyState < 2) return;

      const W = canvas.width;
      const H = canvas.height;

      // Background subtraction → motion pixels
      aCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const frame = aCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
      const curr  = frame.data;

      if (!bgRef.current) {
        const bg = new Float32Array(ANALYSIS_W * ANALYSIS_H * 3);
        for (let i = 0, j = 0; i < curr.length; i += 4, j += 3) {
          bg[j] = curr[i]; bg[j+1] = curr[i+1]; bg[j+2] = curr[i+2];
        }
        bgRef.current = bg;
        warmupFrames  = 0;  // reset warmup every time bg is re-initialized (seek, mode switch)
        return;
      }

      const bg        = bgRef.current;
      const threshold = 75 - (sensitivityRef.current / 100) * 70;
      const scaleX    = W / ANALYSIS_W;
      const scaleY    = H / ANALYSIS_H;
      const warming   = warmupFrames < WARMUP;
      const learnRate = warming ? BG_LEARN_FAST : BG_LEARN;
      const motion: MotionPixel[] = [];

      for (let i = 0, j = 0; i < curr.length; i += 4, j += 3) {
        const dr   = curr[i]   - bg[j];
        const dg   = curr[i+1] - bg[j+1];
        const db   = curr[i+2] - bg[j+2];
        const diff = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        if (!warming && diff > threshold) {
          const idx       = i / 4;
          const col       = idx % ANALYSIS_W;
          const row       = Math.floor(idx / ANALYSIS_W);
          motion.push({
            px: (videoFile ? col : (ANALYSIS_W - 1 - col)) * scaleX,
            py: row * scaleY,
            intensity: Math.min(diff / 280, 1),
          });
        }
        bg[j]   += dr * learnRate;
        bg[j+1] += dg * learnRate;
        bg[j+2] += db * learnRate;
      }

      warmupFrames++;

      if (modeSwitched.current) {
        modeSwitched.current = false;
        r.gesturePing = false;
        r.memoryPing  = false;
        [r.gestureFBOA!, r.gestureFBOB!, r.memoryFBOA!, r.memoryFBOB!].forEach(fbo => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      // Suppress all visual output while background is warming up
      if (warming) return;

      const m = modeRef.current;
      if (m === 'trace') renderTrace(W, H, motion);
      else               renderRain(W, H, motion);
    }

    // ── Trace render — gesture + memory two-layer system ──────────────────────
    function renderTrace(W: number, H: number, motion: MotionPixel[]) {
      const t = trailRef.current / 100;

      // Gesture fades in ~1–2s; memory fades in ~4–6s
      // Trail slider stretches both ranges proportionally
      const gestureFade = 0.962 + t * 0.015;   // 0.962–0.977
      const memoryFade  = 0.990 + t * 0.004;   // 0.990–0.994

      // ── Gesture layer ──────────────────────────────────────────────────────
      const gPing     = r.gesturePing;
      const gReadTex  = gPing ? r.gestureTexA! : r.gestureTexB!;
      const gWriteFBO = gPing ? r.gestureFBOB! : r.gestureFBOA!;
      const gWriteTex = gPing ? r.gestureTexB! : r.gestureTexA!;
      r.gesturePing   = !gPing;

      // Gesture fade pass (overwrites)
      gl.bindFramebuffer(gl.FRAMEBUFFER, gWriteFBO);
      gl.viewport(0, 0, W, H);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(traceFadeProg);
      gl.uniform1i(uTraceFade.scene, 0);
      gl.uniform1f(uTraceFade.fade,  gestureFade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gReadTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Gesture motion pixels — MAX blend so fresh pixels always floor at 0.70
      if (motion.length > 0) {
        const tv = traceVertRef.current;
        const tc = Math.min(motion.length, ANALYSIS_W * ANALYSIS_H);
        for (let k = 0; k < tc; k++) {
          tv[k*3+0] = motion[k].px;
          tv[k*3+1] = motion[k].py;
          tv[k*3+2] = 0; // unused — brightness is fixed in shader
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, traceBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tv.subarray(0, tc * 3));
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(tracePointProg);
        gl.uniform2f(uTracePoint.res, W, H);
        gl.bindVertexArray(traceVAO);
        gl.drawArrays(gl.POINTS, 0, tc);
      }

      // ── Memory layer ───────────────────────────────────────────────────────
      const mPing     = r.memoryPing;
      const mReadTex  = mPing ? r.memoryTexA! : r.memoryTexB!;
      const mWriteFBO = mPing ? r.memoryFBOB! : r.memoryFBOA!;
      const mWriteTex = mPing ? r.memoryTexB! : r.memoryTexA!;
      r.memoryPing    = !mPing;

      // Memory fade pass (overwrites)
      gl.bindFramebuffer(gl.FRAMEBUFFER, mWriteFBO);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(traceFadeProg);
      gl.uniform1i(uTraceFade.scene, 0);
      gl.uniform1f(uTraceFade.fade,  memoryFade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mReadTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Feed: add blurred gesture (0.007×) additively into memory
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(memFeedProg);
      gl.uniform1i(uMemFeed.gesture, 0);
      gl.uniform2f(uMemFeed.texel,   1.0 / W, 1.0 / H);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gWriteTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // ── Composite to screen ────────────────────────────────────────────────
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(compositeProg);
      gl.uniform1i(uComposite.gesture, 0);
      gl.uniform1i(uComposite.memory,  1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gWriteTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mWriteTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Pixel rain render ──────────────────────────────────────────────────────
    function renderRain(W: number, H: number, motion: MotionPixel[]) {
      const cellW = W / MASK_W;
      const cellH = H / MASK_H;
      const mask  = bodyMaskRef.current;

      // Update body mask — decay + accumulate motion
      for (let i = 0; i < mask.length; i++) mask[i] *= 0.94;
      for (const { px, py, intensity } of motion) {
        const cx = Math.min(Math.floor(px / cellW), MASK_W - 1);
        const cy = Math.min(Math.floor(py / cellH), MASK_H - 1);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx+dx, ny = cy+dy;
          if (nx >= 0 && nx < MASK_W && ny >= 0 && ny < MASK_H)
            mask[ny*MASK_W+nx] = Math.min(1, mask[ny*MASK_W+nx] + intensity * 0.6);
        }
      }

      // Sensitivity slider → motion detection threshold (shared with trace mode)
      // Amount slider      → column count (30–240 drops)
      // Trail slider       → fall speed   (12–28 px/frame)
      const activeCount = Math.round(80 + (rainAmountRef.current / 100) * 320);
      const baseSpeed   = 12 + (trailRef.current / 100) * 16;
      const HIT_THRESH  = 0.20;

      // Grow column pool with random x positions — more rain-like than even grid
      while (colsRef.current.length < activeCount) {
        colsRef.current.push({
          xNorm:    Math.random(),
          x:        0,
          headY:    Math.random() * H,
          speedVar: 0.7 + Math.random() * 0.6,
          hitTimer: 0,
          hitY:     0,
        });
      }

      // Simulate
      for (let ci = 0; ci < activeCount; ci++) {
        const col = colsRef.current[ci];
        col.x     = col.xNorm * W;
        const speed = baseSpeed * col.speedVar;

        if (col.hitTimer > 0) {
          col.hitTimer--;
          if (col.hitTimer === 0) {
            col.xNorm    = Math.random();
            col.headY    = -(TRAIL_DOTS * TRAIL_GAP + Math.random() * H * 0.3);
            col.speedVar = 0.7 + Math.random() * 0.6;
          }
        } else {
          col.headY += speed;

          if (col.headY > 0) {
            const cx = Math.min(Math.max(Math.floor(col.x     / cellW), 0), MASK_W - 1);
            const cy = Math.min(Math.max(Math.floor(col.headY / cellH), 0), MASK_H - 1);
            if (mask[cy * MASK_W + cx] > HIT_THRESH) {
              col.hitTimer = HIT_FRAMES;
              col.hitY     = col.headY;
            }
          }

          if (col.headY > H + TRAIL_DOTS * TRAIL_GAP) {
            col.xNorm    = Math.random();
            col.headY    = -(TRAIL_DOTS * TRAIL_GAP + Math.random() * H * 0.1);
            col.speedVar = 0.7 + Math.random() * 0.6;
          }
        }
      }

      // Build vertex buffer — head + fading trail + hit spread
      const vd = colVertRef.current;
      let vc   = 0;

      for (let ci = 0; ci < activeCount; ci++) {
        const col     = colsRef.current[ci];
        const frozen  = col.hitTimer > 0;
        const hitFade = col.hitTimer / HIT_FRAMES;
        const anchorY = frozen ? col.hitY : col.headY;

        for (let p = 0; p < TRAIL_DOTS; p++) {
          const py = anchorY - p * TRAIL_GAP;
          if (py < -4 || py > H + 4) continue;
          let bright = p === 0 ? 1.0 : (1 - p / TRAIL_DOTS) * 0.6;
          if (frozen) bright *= hitFade;
          vd[vc*3+0] = col.x;  vd[vc*3+1] = py;  vd[vc*3+2] = bright;
          vc++;
        }

        if (frozen) {
          for (let s = -2; s <= 2; s++) {
            const bright = hitFade * (1 - Math.abs(s) * 0.35);
            vd[vc*3+0] = col.x + s * 4;
            vd[vc*3+1] = col.hitY;
            vd[vc*3+2] = bright;
            vc++;
          }
        }
      }

      // Clear + draw directly to screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (vc > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vd.subarray(0, vc * 3));
        gl.blendFunc(gl.ONE, gl.ZERO);
        gl.useProgram(pixRainProg);
        gl.uniform2f(uPixRain.res, W, H);
        gl.bindVertexArray(colVAO);
        gl.drawArrays(gl.POINTS, 0, vc);
      }
    }

    // ── Source: video file or camera ───────────────────────────────────────────
    let objectUrl: string | null = null;

    if (videoFile) {
      objectUrl  = URL.createObjectURL(videoFile);
      video.src  = objectUrl;
      video.loop = false;  // single-pass processing

      let tooLong = false;

      video.addEventListener('loadedmetadata', () => {
        if (video.duration > 90) {
          tooLong = true;
          setVideoTooLong(true);
          return;
        }
        setDuration(video.duration);
      }, { once: true });

      video.addEventListener('timeupdate', () => {
        setCurrentTime(video.currentTime);
        if (video.duration > 0)
          setProcessProgress(Math.round((video.currentTime / video.duration) * 100));
      });

      video.addEventListener('loadeddata', () => {
        if (tooLong) return;

        // Set up MediaRecorder on WebGL canvas — prefer H.264 MP4
        const captureStream = canvas.captureStream(30);
        const mimes = [
          'video/mp4; codecs="avc1.42E01E"',
          'video/mp4; codecs="avc1"',
          'video/mp4',
          'video/webm; codecs=vp9',
          'video/webm',
        ];
        let mimeType = '';
        for (const m of mimes) {
          try { if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; } } catch {}
        }

        const recorder = new MediaRecorder(captureStream, mimeType ? { mimeType } : {});
        recorderRef.current = recorder;
        const chunks: BlobPart[] = [];

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          cancelAnimationFrame(rafRef.current);
          const blob = new Blob(chunks, { type: mimeType || 'video/mp4' });
          const url  = URL.createObjectURL(blob);
          processedUrlRef.current = url;
          setProcessedUrl(url);
          videoPhaseRef.current = 'playback';
          setVideoPhase('playback');
        };

        video.addEventListener('ended', () => {
          if (recorder.state === 'recording') recorder.stop();
        }, { once: true });

        recorder.start(100);  // collect data every 100 ms
        animate();
        video.play().catch(() => {});
      }, { once: true });
    } else {
      if (!navigator.mediaDevices?.getUserMedia) { onError('unsupported'); return; }
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
        .then((stream) => {
          if (aborted) { stream.getTracks().forEach(t => t.stop()); return; }
          streamRef.current = stream;
          video.srcObject   = stream;
          video.play().catch(() => {});
          video.addEventListener('playing', () => animate(), { once: true });
        })
        .catch((err: DOMException) => {
          if (aborted || err.name === 'AbortError') return;
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') onError('denied');
          else if (err.name === 'NotFoundError') onError('no-camera');
          else onError('unsupported');
        });
    }

    return () => {
      aborted = true;
      cancelAnimationFrame(rafRef.current);
      if (pbRestartTimerRef.current) clearTimeout(pbRestartTimerRef.current);
      window.removeEventListener('resize', handleResize);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (processedUrlRef.current) URL.revokeObjectURL(processedUrlRef.current);
      if (!videoFile) streamRef.current?.getTracks().forEach(t => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── JSX ────────────────────────────────────────────────────────────────────
  const isProcessing = !!videoFile && videoPhase === 'processing';
  const isPlayback   = !!videoFile && videoPhase === 'playback';

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={analysisRef} className="hidden" />

      {/* WebGL canvas — fades out once processing finishes */}
      <canvas ref={canvasRef} className={`absolute inset-0 w-full h-full transition-opacity duration-700
        ${isPlayback ? 'opacity-0 pointer-events-none' : 'opacity-100'}`} />

      {/* Processed video — fades in after processing */}
      {processedUrl && (
        <video
          ref={playbackRef}
          src={processedUrl}
          playsInline
          muted
          autoPlay
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700
            ${isPlayback ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onPlay={() => setPbPlaying(true)}
          onPause={() => setPbPlaying(false)}
          onTimeUpdate={() => { const pb = playbackRef.current; if (pb) setPbTime(pb.currentTime); }}
          onLoadedMetadata={() => { const pb = playbackRef.current; if (pb) setPbDuration(pb.duration); }}
          onEnded={handlePbEnded}
        />
      )}

      {/* Black screen on loop restart */}
      {pbBlackScreen && <div className="absolute inset-0 bg-black z-10" />}

      {/* Processing progress bar — thin white line at top */}
      {isProcessing && !videoTooLong && (
        <div className="absolute top-0 left-0 right-0 h-[2px] z-20 bg-white/10">
          <div
            className="h-full bg-white/55 transition-[width] duration-300 ease-out"
            style={{ width: `${processProgress}%` }}
          />
        </div>
      )}

      {/* Video too long error */}
      {videoTooLong && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-30 bg-black/90 gap-5">
          <p className="text-[11px] tracking-[0.22em] uppercase text-white/60">
            Video exceeds 90-second limit
          </p>
          <button
            onClick={onStop}
            className="text-[10px] tracking-[0.28em] uppercase text-white/35
              hover:text-white/65 transition-colors duration-200 cursor-pointer focus:outline-none"
          >
            Go back
          </button>
        </div>
      )}

      {/* Indicator pill */}
      <div className="absolute top-5 left-5 pointer-events-none select-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-black/55 backdrop-blur-sm border border-white/[0.07]">
          <span className={`block w-1.5 h-1.5 rounded-full ${
            isProcessing
              ? 'bg-amber-400/80 shadow-[0_0_5px_rgba(251,191,36,0.6)] animate-pulse'
              : videoFile
              ? 'bg-blue-400/80 shadow-[0_0_5px_rgba(96,165,250,0.6)]'
              : 'bg-green-400/80 shadow-[0_0_5px_rgba(74,222,128,0.6)]'
          }`} />
          <span className="text-[9px] tracking-[0.25em] uppercase text-white/50">
            {isProcessing ? 'Processing' : videoFile ? 'File' : 'Live'}
          </span>
        </div>
      </div>

      {/* Controls — always visible during processing, auto-hide otherwise */}
      <div className={`absolute inset-x-0 bottom-0 transition-all duration-500 ease-out
        ${(controlsVisible || isProcessing)
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-3 pointer-events-none'}`}
      >
        <Controls
          sensitivity={sensitivity}
          trailLength={trailLength}
          rainAmount={rainAmount}
          mode={mode}
          onSensitivityChange={setSensitivity}
          onTrailLengthChange={setTrailLength}
          onRainAmountChange={setRainAmount}
          onModeChange={setMode}
          onStop={onStop}
          onInteract={revealControls}
          locked={isProcessing}
          onDownload={isPlayback ? handleDownload : undefined}
          videoControls={isPlayback
            ? { isPlaying: pbPlaying, currentTime: pbTime, duration: pbDuration,
                onPlayPause: togglePbPlay, onSeek: handlePbSeek }
            : undefined}
        />
      </div>
    </div>
  );
}
