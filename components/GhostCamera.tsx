'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Controls from './Controls';

// ── Constants ─────────────────────────────────────────────────────────────────
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;
const MASK_W     = 80;
const MASK_H     = 45;
const BG_LEARN   = 0.05;
const COL_MAX     = 240;   // max columns (Sensitivity=100)
const COL_SPACING = 3;     // px between trail dots
const TRAIL_PX    = 9;     // fixed trail length — head + 2 fading dots
const HIT_FRAMES  = 18;    // frames a column stays frozen after impact

// ── Types ─────────────────────────────────────────────────────────────────────
export type ErrorType  = 'denied' | 'no-camera' | 'unsupported';
export type VisualMode = 'trace' | 'rain';

interface MotionPixel { px: number; py: number; intensity: number }

interface Column {
  x:        number;  // screen-x (recomputed each frame from activeCount)
  headY:    number;  // leading pixel Y (moves down)
  speedVar: number;  // multiplier 0.7–1.3 — baked at spawn, varies columns naturally
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

// Trace — crisp circle point sprite
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
  float b = 0.45 + v_intens * 0.55;
  out_color = vec4(vec3(b), 1.0);
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
  const modeRef        = useRef<VisualMode>('trace');

  // Rain — column simulation state
  const colsRef     = useRef<Column[]>([]);
  const bodyMaskRef = useRef(new Float32Array(MASK_W * MASK_H));
  // x, y, brightness — 3 floats per pixel vertex
  const colVertRef  = useRef(new Float32Array(COL_MAX * 55 * 3));

  // Trace
  const traceVertRef = useRef(new Float32Array(ANALYSIS_W * ANALYSIS_H * 3));

  const [sensitivity, setSensitivity] = useState(30);
  const [trailLength, setTrailLength] = useState(50);
  const [mode, setMode]               = useState<VisualMode>('trace');
  const [controlsVisible, setControlsVisible] = useState(true);

  const [isPlaying, setIsPlaying]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);

  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { trailRef.current       = trailLength; }, [trailLength]);
  useEffect(() => { modeRef.current        = mode;        }, [mode]);

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

    let traceFadeProg: WebGLProgram, tracePointProg: WebGLProgram, pixRainProg: WebGLProgram;
    try {
      traceFadeProg  = createProg(gl, V_QUAD,        F_TRACE_FADE);
      tracePointProg = createProg(gl, V_TRACE_POINT, F_TRACE_POINT);
      pixRainProg    = createProg(gl, V_PIX_RAIN,    F_PIX_RAIN);
    } catch (e) {
      console.error(e);
      onError('unsupported');
      return;
    }

    const uTraceFade  = { scene: gl.getUniformLocation(traceFadeProg,  'u_scene'), fade: gl.getUniformLocation(traceFadeProg, 'u_fade') };
    const uTracePoint = { res:   gl.getUniformLocation(tracePointProg, 'u_res') };
    const uPixRain    = { res:   gl.getUniformLocation(pixRainProg,    'u_res') };

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

    // Trace ping-pong FBOs only (rain renders directly to screen)
    const r = {
      traceTexA: null as WebGLTexture | null,
      traceTexB: null as WebGLTexture | null,
      traceFBOA: null as WebGLFramebuffer | null,
      traceFBOB: null as WebGLFramebuffer | null,
      tracePing: false,
    };

    const handleResize = () => resizeGL(window.innerWidth, window.innerHeight);

    function resizeGL(W: number, H: number) {
      canvas.width  = W;
      canvas.height = H;
      gl.viewport(0, 0, W, H);
      [r.traceTexA, r.traceTexB].forEach(t => t && gl.deleteTexture(t));
      [r.traceFBOA, r.traceFBOB].forEach(f => f && gl.deleteFramebuffer(f));
      r.traceTexA = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.traceTexB = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.traceFBOA = createFBO(gl, r.traceTexA);
      r.traceFBOB = createFBO(gl, r.traceTexB);
      r.tracePing = false;
      // Recompute column x positions on resize
      const activeCols = colsRef.current.length;
      for (let i = 0; i < activeCols; i++) {
        colsRef.current[i].x = (i + 0.5) / activeCols * W;
      }
    }
    resizeGL(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', handleResize);

    let aborted = false;

    // ── rAF loop ───────────────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate);
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
        return;
      }

      const bg        = bgRef.current;
      const threshold = 75 - (sensitivityRef.current / 100) * 70;
      const scaleX    = W / ANALYSIS_W;
      const scaleY    = H / ANALYSIS_H;
      const motion: MotionPixel[] = [];

      for (let i = 0, j = 0; i < curr.length; i += 4, j += 3) {
        const dr   = curr[i]   - bg[j];
        const dg   = curr[i+1] - bg[j+1];
        const db   = curr[i+2] - bg[j+2];
        const diff = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        if (diff > threshold) {
          const idx       = i / 4;
          const col       = idx % ANALYSIS_W;
          const row       = Math.floor(idx / ANALYSIS_W);
          motion.push({
            px: (ANALYSIS_W - 1 - col) * scaleX,
            py: row * scaleY,
            intensity: Math.min(diff / 280, 1),
          });
        }
        bg[j]   += dr * BG_LEARN;
        bg[j+1] += dg * BG_LEARN;
        bg[j+2] += db * BG_LEARN;
      }

      if (modeSwitched.current) {
        modeSwitched.current = false;
        r.tracePing = false;
        ([r.traceFBOA!, r.traceFBOB!]).forEach(fbo => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      const m = modeRef.current;
      if (m === 'trace') renderTrace(W, H, motion);
      else               renderRain(W, H, motion);
    }

    // ── Trace render ───────────────────────────────────────────────────────────
    function renderTrace(W: number, H: number, motion: MotionPixel[]) {
      const ping     = r.tracePing;
      const readTex  = ping ? r.traceTexA! : r.traceTexB!;
      const writeFBO = ping ? r.traceFBOB! : r.traceFBOA!;
      const writeTex = ping ? r.traceTexB! : r.traceTexA!;
      r.tracePing    = !ping;

      const fade = 0.65 + (trailRef.current / 100) * 0.30;

      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
      gl.viewport(0, 0, W, H);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(traceFadeProg);
      gl.uniform1i(uTraceFade.scene, 0);
      gl.uniform1f(uTraceFade.fade,  fade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (motion.length > 0) {
        const tv = traceVertRef.current;
        const tc = Math.min(motion.length, ANALYSIS_W * ANALYSIS_H);
        for (let k = 0; k < tc; k++) {
          tv[k*3+0] = motion[k].px;
          tv[k*3+1] = motion[k].py;
          tv[k*3+2] = motion[k].intensity;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, traceBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tv.subarray(0, tc * 3));
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(tracePointProg);
        gl.uniform2f(uTracePoint.res, W, H);
        gl.bindVertexArray(traceVAO);
        gl.drawArrays(gl.POINTS, 0, tc);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(traceFadeProg);
      gl.uniform1i(uTraceFade.scene, 0);
      gl.uniform1f(uTraceFade.fade,  1.0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, writeTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Pixel rain render ──────────────────────────────────────────────────────
    function renderRain(W: number, H: number, motion: MotionPixel[]) {
      const cellW = W / MASK_W;
      const cellH = H / MASK_H;
      const mask  = bodyMaskRef.current;

      // Update body mask
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

      // Sensitivity slider → rain amount (60–240 columns)
      // Trail slider     → rain speed  (10–22 px/frame base)
      const activeCount = Math.round(60 + (sensitivityRef.current / 100) * 180);
      const baseSpeed   = 10 + (trailRef.current / 100) * 12;
      const maxPixels   = Math.floor(TRAIL_PX / COL_SPACING); // always 3 dots
      const HIT_THRESH  = 0.20; // fixed body-hit sensitivity

      // Grow column pool when more columns needed
      while (colsRef.current.length < activeCount) {
        colsRef.current.push({
          x:        0,
          headY:    Math.random() * H,          // staggered start — not all at top
          speedVar: 0.7 + Math.random() * 0.6,  // 0.7–1.3 multiplier
          hitTimer: 0,
          hitY:     0,
        });
      }

      // Recompute x every frame so columns stay evenly distributed
      for (let i = 0; i < activeCount; i++) {
        colsRef.current[i].x = (i + 0.5) / activeCount * W;
      }

      // Simulate
      for (let ci = 0; ci < activeCount; ci++) {
        const col   = colsRef.current[ci];
        const speed = baseSpeed * col.speedVar;

        if (col.hitTimer > 0) {
          col.hitTimer--;
          if (col.hitTimer === 0) {
            col.headY    = -(TRAIL_PX + Math.random() * H * 0.3);
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

          if (col.headY > H + TRAIL_PX) {
            col.headY    = -(TRAIL_PX + Math.random() * H * 0.1);
            col.speedVar = 0.7 + Math.random() * 0.6;
          }
        }
      }

      // Build vertex buffer
      const vd = colVertRef.current;
      let vc   = 0;

      for (let ci = 0; ci < activeCount; ci++) {
        const col      = colsRef.current[ci];
        const frozen   = col.hitTimer > 0;
        const hitFade  = col.hitTimer / HIT_FRAMES;
        const anchorY  = frozen ? col.hitY : col.headY;

        // Head + 2 fading dots above
        for (let p = 0; p < maxPixels; p++) {
          const py = anchorY - p * COL_SPACING;
          if (py < -4 || py > H + 4) continue;
          let bright = p === 0 ? 1.0 : (1 - p / maxPixels);
          if (frozen) bright *= hitFade;
          vd[vc*3+0] = col.x;  vd[vc*3+1] = py;  vd[vc*3+2] = bright;
          vc++;
        }

        // Hit spread — 5 pixels horizontal at impact point, fades with timer
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

      // Render directly to screen — clear + draw, no ping-pong needed
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
      objectUrl = URL.createObjectURL(videoFile);
      video.src  = objectUrl;
      video.loop = true;
      video.addEventListener('loadedmetadata', () => setDuration(video.duration), { once: true });
      video.addEventListener('timeupdate',     () => setCurrentTime(video.currentTime));
      video.addEventListener('play',           () => setIsPlaying(true));
      video.addEventListener('pause',          () => setIsPlaying(false));
      video.addEventListener('loadeddata', () => {
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
      window.removeEventListener('resize', handleResize);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      else streamRef.current?.getTracks().forEach(t => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={analysisRef} className="hidden" />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Live / File indicator */}
      <div className="absolute top-5 left-5 pointer-events-none select-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-black/55 backdrop-blur-sm border border-white/[0.07]">
          <span className={`block w-1.5 h-1.5 rounded-full ${
            videoFile
              ? 'bg-blue-400/80 shadow-[0_0_5px_rgba(96,165,250,0.6)]'
              : 'bg-green-400/80 shadow-[0_0_5px_rgba(74,222,128,0.6)]'
          }`} />
          <span className="text-[9px] tracking-[0.25em] uppercase text-white/50">
            {videoFile ? 'File' : 'Live'}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className={`absolute inset-x-0 bottom-0 transition-all duration-500 ease-out
        ${controlsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3 pointer-events-none'}`}
      >
        <Controls
          sensitivity={sensitivity}
          trailLength={trailLength}
          mode={mode}
          onSensitivityChange={setSensitivity}
          onTrailLengthChange={setTrailLength}
          onModeChange={setMode}
          onStop={onStop}
          onInteract={revealControls}
          videoControls={videoFile
            ? { isPlaying, currentTime, duration, onPlayPause: togglePlayPause, onSeek: handleSeek }
            : undefined}
        />
      </div>
    </div>
  );
}
