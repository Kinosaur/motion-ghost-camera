'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Controls from './Controls';

// ── Constants ─────────────────────────────────────────────────────────────────
const ANALYSIS_W      = 320;
const ANALYSIS_H      = 180;
const MAX_DROPS       = 15_000;
const MAX_GHOST_PTS   = ANALYSIS_W * ANALYSIS_H; // worst-case all pixels changed
const MASK_W          = 80;
const MASK_H          = 45;

// ── Types ─────────────────────────────────────────────────────────────────────
export type ErrorType  = 'denied' | 'no-camera' | 'unsupported';
export type VisualMode = 'ghost' | 'rain';

interface MotionPixel { px: number; py: number; intensity: number }
interface Drop { x: number; y: number; vx: number; vy: number; alpha: number; size: number; bloom: boolean }
interface Props { onError: (t: ErrorType) => void; onStop: () => void }

// ── GLSL Shaders ──────────────────────────────────────────────────────────────

// Shared fullscreen-quad vertex shader
const V_QUAD = /* glsl */`#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Shared fade/blit shader — multiplies scene texture by u_fade (use 1.0 to blit)
const F_FADE = /* glsl */`#version 300 es
precision mediump float;
uniform sampler2D u_scene;
uniform float u_fade;
in vec2 v_uv;
out vec4 out_color;
void main(){ out_color = texture(u_scene, v_uv) * u_fade; }`;

// Ghost — crisp point sprites, one per motion pixel
// a_pos is already in screen-space pixels (mirrored selfie, y=0 at top)
const V_GHOST_POINT = /* glsl */`#version 300 es
layout(location=0) in vec2  a_pos;
layout(location=1) in float a_intens;
out float v_intens;
uniform vec2 u_res;
void main(){
  v_intens    = a_intens;
  vec2 ndc    = vec2(a_pos.x / u_res.x * 2.0 - 1.0,
                     1.0 - a_pos.y / u_res.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = 3.0;
}`;

const F_GHOST_POINT = /* glsl */`#version 300 es
precision highp float;
in float v_intens;
out vec4 out_color;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  if(length(c) > 0.5) discard;
  float b = 0.45 + v_intens * 0.55;
  out_color = vec4(vec3(b), 1.0);
}`;

// Rain — point-sprite drops (head + tail as separate points)
const V_RAIN_DROP = /* glsl */`#version 300 es
layout(location=0) in vec2  a_pos;
layout(location=1) in float a_alpha;
layout(location=2) in float a_size;
layout(location=3) in float a_bloom;
out float v_alpha;
out float v_bloom;
uniform vec2 u_res;
void main(){
  v_alpha = a_alpha;
  v_bloom = a_bloom;
  vec2 ndc = vec2(a_pos.x/u_res.x*2.0-1.0, 1.0-a_pos.y/u_res.y*2.0);
  gl_Position  = vec4(ndc, 0.0, 1.0);
  gl_PointSize = a_bloom > 0.5 ? a_size*22.0+8.0 : a_size*14.0+5.0;
}`;

const F_RAIN_DROP = /* glsl */`#version 300 es
precision mediump float;
in float v_alpha;
in float v_bloom;
out vec4 out_color;
void main(){
  vec2  c  = vec2((gl_PointCoord.x - 0.5) * 3.5, gl_PointCoord.y - 0.5);
  float d  = length(c) * 2.0;
  if(d > 1.0) discard;
  float glow = v_bloom > 0.5
    ? pow(1.0-d, 1.3) * v_alpha
    : (1.0-d*0.45)    * v_alpha * 0.85;
  out_color = vec4(vec3(glow), glow);
}`;

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
export default function GhostCamera({ onError, onStop }: Props) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const analysisRef   = useRef<HTMLCanvasElement>(null);
  const prevFrameRef  = useRef<Uint8ClampedArray | null>(null);
  const rafRef        = useRef<number>(0);
  const streamRef     = useRef<MediaStream | null>(null);
  const hideTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeSwitched  = useRef(false);

  const sensitivityRef = useRef(30);
  const trailRef       = useRef(50);
  const modeRef        = useRef<VisualMode>('ghost');

  const rainRef        = useRef<Drop[]>([]);
  const bodyMaskRef    = useRef(new Float32Array(MASK_W * MASK_H));
  const dropVertRef    = useRef(new Float32Array(MAX_DROPS * 2 * 5));
  const ghostVertRef   = useRef(new Float32Array(MAX_GHOST_PTS * 3)); // x, y, intensity

  const [sensitivity, setSensitivity] = useState(30);
  const [trailLength, setTrailLength] = useState(50);
  const [mode, setMode]               = useState<VisualMode>('ghost');
  const [controlsVisible, setControlsVisible] = useState(true);

  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { trailRef.current       = trailLength; }, [trailLength]);
  useEffect(() => { modeRef.current        = mode;        }, [mode]);

  useEffect(() => {
    rainRef.current      = [];
    bodyMaskRef.current.fill(0);
    prevFrameRef.current = null;
    modeSwitched.current = true;
  }, [mode]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);

  useEffect(() => {
    revealControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [revealControls]);

  // ── Main effect: WebGL + camera + rAF ────────────────────────────────────
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) { onError('unsupported'); return; }

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

    // ── Compile programs ────────────────────────────────────────────────────
    let fadeProg: WebGLProgram, ghostPointProg: WebGLProgram;
    let rainDropProg: WebGLProgram;
    try {
      fadeProg       = createProg(gl, V_QUAD,        F_FADE);
      ghostPointProg = createProg(gl, V_GHOST_POINT, F_GHOST_POINT);
      rainDropProg   = createProg(gl, V_RAIN_DROP,   F_RAIN_DROP);
    } catch (e) {
      console.error(e);
      onError('unsupported');
      return;
    }

    const uFade      = { scene: gl.getUniformLocation(fadeProg,       'u_scene'),
                         fade:  gl.getUniformLocation(fadeProg,       'u_fade')  };
    const uGhostPt   = { res:   gl.getUniformLocation(ghostPointProg, 'u_res')   };
    const uRainDrop  = { res:   gl.getUniformLocation(rainDropProg,   'u_res')   };

    // ── Fullscreen quad VAO ─────────────────────────────────────────────────
    const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const quadVAO   = gl.createVertexArray()!;
    gl.bindVertexArray(quadVAO);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // ── Ghost point-sprite VAO (x, y, intensity — 3 floats per point) ──────
    const ghostVAO = gl.createVertexArray()!;
    gl.bindVertexArray(ghostVAO);
    const ghostBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ghostBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ghostVertRef.current.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 3*4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 3*4, 2*4);
    gl.bindVertexArray(null);

    // ── Rain drop point-sprite VAO ──────────────────────────────────────────
    const STRIDE = 5 * 4;
    const dropVAO = gl.createVertexArray()!;
    gl.bindVertexArray(dropVAO);
    const dropBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, dropBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dropVertRef.current.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE, 2*4);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 3*4);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 4*4);
    gl.bindVertexArray(null);

    // ── Framebuffer ping-pong textures ──────────────────────────────────────
    const r = {
      ghostTexA: null as WebGLTexture | null,
      ghostTexB: null as WebGLTexture | null,
      ghostFBOA: null as WebGLFramebuffer | null,
      ghostFBOB: null as WebGLFramebuffer | null,
      rainTexA:  null as WebGLTexture | null,
      rainTexB:  null as WebGLTexture | null,
      rainFBOA:  null as WebGLFramebuffer | null,
      rainFBOB:  null as WebGLFramebuffer | null,
      ghostPing: false,
      rainPing:  false,
    };

    const resizeGL = (W: number, H: number) => {
      canvas.width  = W;
      canvas.height = H;
      gl.viewport(0, 0, W, H);
      [r.ghostTexA, r.ghostTexB, r.rainTexA, r.rainTexB].forEach(t => t && gl.deleteTexture(t));
      [r.ghostFBOA, r.ghostFBOB, r.rainFBOA, r.rainFBOB].forEach(f => f && gl.deleteFramebuffer(f));
      r.ghostTexA = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.ghostTexB = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.ghostFBOA = createFBO(gl, r.ghostTexA);
      r.ghostFBOB = createFBO(gl, r.ghostTexB);
      r.rainTexA  = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.rainTexB  = createTex(gl, W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      r.rainFBOA  = createFBO(gl, r.rainTexA);
      r.rainFBOB  = createFBO(gl, r.rainTexB);
      r.ghostPing = false;
      r.rainPing  = false;
    };
    resizeGL(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', () => resizeGL(window.innerWidth, window.innerHeight));

    let aborted = false;

    // ── rAF loop ──────────────────────────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      if (video.readyState < 2) return;

      const W = canvas.width;
      const H = canvas.height;

      aCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const frame = aCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
      const curr  = frame.data;
      const prev  = prevFrameRef.current;
      if (!prev) { prevFrameRef.current = new Uint8ClampedArray(curr); return; }

      const threshold = 75 - (sensitivityRef.current / 100) * 70;
      const scaleX    = W / ANALYSIS_W;
      const scaleY    = H / ANALYSIS_H;

      const motion: MotionPixel[] = [];
      for (let i = 0; i < curr.length; i += 4) {
        const diff = Math.abs(curr[i]-prev[i]) + Math.abs(curr[i+1]-prev[i+1]) + Math.abs(curr[i+2]-prev[i+2]);
        if (diff > threshold) {
          const idx = i / 4;
          const col = idx % ANALYSIS_W;
          const row = Math.floor(idx / ANALYSIS_W);
          motion.push({
            px: (ANALYSIS_W - 1 - col) * scaleX, // mirror X for selfie view
            py: row * scaleY,                      // y=0 at top of screen
            intensity: Math.min(diff / 280, 1),
          });
        }
      }

      if (modeSwitched.current) {
        modeSwitched.current = false;
        r.ghostPing = false;
        r.rainPing  = false;
        ([r.ghostFBOA!, r.ghostFBOB!, r.rainFBOA!, r.rainFBOB!]).forEach(fbo => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }

      const mode = modeRef.current;
      if (mode === 'ghost') renderGhost(W, H, motion);
      else                  renderRain(W, H, motion);

      prevFrameRef.current = new Uint8ClampedArray(curr);
    }

    // ── Ghost render ─────────────────────────────────────────────────────────
    // Three steps: fade trail → paint crisp dots → blit to screen
    function renderGhost(W: number, H: number, motion: MotionPixel[]) {
      const ping     = r.ghostPing;
      const readTex  = ping ? r.ghostTexA! : r.ghostTexB!;
      const writeFBO = ping ? r.ghostFBOB! : r.ghostFBOA!;
      const writeTex = ping ? r.ghostTexB! : r.ghostTexA!;
      r.ghostPing    = !ping;

      const fade = 0.65 + (trailRef.current / 100) * 0.30; // 0.65 → 0.95

      // Step 1: decay previous trail into write FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
      gl.viewport(0, 0, W, H);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(fadeProg);
      gl.uniform1i(uFade.scene, 0);
      gl.uniform1f(uFade.fade,  fade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Step 2: additively paint each changed pixel as a 3px crisp circle
      if (motion.length > 0) {
        const gv    = ghostVertRef.current;
        const count = Math.min(motion.length, MAX_GHOST_PTS);
        for (let i = 0; i < count; i++) {
          gv[i*3+0] = motion[i].px;
          gv[i*3+1] = motion[i].py;
          gv[i*3+2] = motion[i].intensity;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, ghostBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, gv.subarray(0, count * 3));
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(ghostPointProg);
        gl.uniform2f(uGhostPt.res, W, H);
        gl.bindVertexArray(ghostVAO);
        gl.drawArrays(gl.POINTS, 0, count);
      }

      // Step 3: blit to screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(fadeProg);
      gl.uniform1i(uFade.scene, 0);
      gl.uniform1f(uFade.fade,  1.0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, writeTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Rain render ───────────────────────────────────────────────────────────
    function renderRain(W: number, H: number, motion: MotionPixel[]) {
      const cellW = W / MASK_W;
      const cellH = H / MASK_H;
      const mask  = bodyMaskRef.current;

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

      const density = 6 + Math.round((trailRef.current / 100) * 44);
      for (let i = 0; i < density && rainRef.current.length < MAX_DROPS; i++) {
        rainRef.current.push({
          x:     Math.random() * W,
          y:     -8,
          vx:    (Math.random() - 0.5) * 0.5,
          vy:    3.5 + Math.random() * 3,
          alpha: 0.55 + Math.random() * 0.40,
          size:  0.7  + Math.random() * 0.8,
          bloom: false,
        });
      }

      const alive: Drop[] = [];
      for (const d of rainRef.current) {
        const nextY = d.y + d.vy;
        const cx    = Math.min(Math.max(Math.floor(d.x   / cellW), 0), MASK_W - 1);
        const cy    = Math.min(Math.max(Math.floor(nextY / cellH), 0), MASK_H - 1);
        if (mask[cy * MASK_W + cx] > 0.3) {
          d.bloom  = true;
          d.alpha -= 0.035;
        } else {
          d.vy    += 0.2;
          d.y      = nextY;
          d.x     += d.vx;
          d.alpha -= 0.003;
        }
        if (d.alpha > 0 && d.y < H + 20) alive.push(d);
      }
      rainRef.current = alive;

      const vd = dropVertRef.current;
      let vc   = 0;
      for (const d of alive) {
        if (d.bloom) {
          vd[vc*5+0]=d.x; vd[vc*5+1]=d.y;
          vd[vc*5+2]=d.alpha; vd[vc*5+3]=d.size; vd[vc*5+4]=1;
          vc++;
        } else {
          vd[vc*5+0]=d.x; vd[vc*5+1]=d.y;
          vd[vc*5+2]=d.alpha; vd[vc*5+3]=d.size; vd[vc*5+4]=0; vc++;
          const ty = d.y - Math.min(d.vy * 2.2, 18);
          vd[vc*5+0]=d.x+d.vx; vd[vc*5+1]=ty;
          vd[vc*5+2]=d.alpha*0.22; vd[vc*5+3]=d.size*0.65; vd[vc*5+4]=0; vc++;
        }
      }

      const ping     = r.rainPing;
      const readTex  = ping ? r.rainTexA! : r.rainTexB!;
      const writeFBO = ping ? r.rainFBOB! : r.rainFBOA!;
      const writeTex = ping ? r.rainTexB! : r.rainTexA!;
      r.rainPing     = !ping;

      const fade = 0.90 + (trailRef.current / 100) * 0.08;

      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
      gl.viewport(0, 0, W, H);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(fadeProg);
      gl.uniform1i(uFade.scene, 0);
      gl.uniform1f(uFade.fade,  fade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (vc > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, dropBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vd.subarray(0, vc * 5));
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(rainDropProg);
        gl.uniform2f(uRainDrop.res, W, H);
        gl.bindVertexArray(dropVAO);
        gl.drawArrays(gl.POINTS, 0, vc);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.useProgram(fadeProg);
      gl.uniform1i(uFade.scene, 0);
      gl.uniform1f(uFade.fade,  1.0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, writeTex);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Camera start ──────────────────────────────────────────────────────────
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

    return () => {
      aborted = true;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', () => resizeGL(window.innerWidth, window.innerHeight));
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={analysisRef} className="hidden" />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      <div className="absolute top-5 left-5 pointer-events-none select-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-black/55 backdrop-blur-sm border border-white/[0.07]">
          <span className="block w-1.5 h-1.5 rounded-full bg-green-400/80
            shadow-[0_0_5px_rgba(74,222,128,0.6)]" />
          <span className="text-[9px] tracking-[0.25em] uppercase text-white/50">Live</span>
        </div>
      </div>

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
        />
      </div>
    </div>
  );
}
