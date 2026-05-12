'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import Controls from './Controls';

// ── Constants ────────────────────────────────────────────────────────────────
const ANALYSIS_W    = 320;
const ANALYSIS_H    = 180;
const MAX_DROPS     = 3000;
const WEB_NODES     = 220;
const WEB_LINK_NORM = 0.17;
const MASK_W        = 80;
const MASK_H        = 45;

// ── Types ────────────────────────────────────────────────────────────────────
export type ErrorType  = 'denied' | 'no-camera' | 'unsupported';
export type VisualMode = 'ghost' | 'web' | 'rain';

interface MotionPixel { px: number; py: number; intensity: number }
interface Drop        { x: number; y: number; vx: number; vy: number; alpha: number; size: number; r: number; g: number; b: number }
type CNode = { nx: number; ny: number };
type CEdge = { a: number; b: number };

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { onError: (t: ErrorType) => void; onStop: () => void }

export default function GhostCamera({ onError, onStop }: Props) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const analysisRef  = useRef<HTMLCanvasElement>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const rafRef       = useRef<number>(0);
  const streamRef    = useRef<MediaStream | null>(null);
  const hideTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensitivityRef = useRef(30);
  const trailRef       = useRef(50);
  const modeRef        = useRef<VisualMode>('ghost');

  const rainRef          = useRef<Drop[]>([]);
  const bodyMaskRef      = useRef(new Float32Array(MASK_W * MASK_H));
  const constellationRef = useRef<{ nodes: CNode[]; edges: CEdge[] } | null>(null);

  const [sensitivity, setSensitivity] = useState(30);
  const [trailLength, setTrailLength] = useState(50);
  const [mode, setMode]               = useState<VisualMode>('ghost');
  const [controlsVisible, setControlsVisible] = useState(true);

  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { trailRef.current       = trailLength; }, [trailLength]);
  useEffect(() => { modeRef.current        = mode;        }, [mode]);

  useEffect(() => {
    rainRef.current          = [];
    bodyMaskRef.current.fill(0);
    constellationRef.current = null;
    prevFrameRef.current     = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [mode]);

  // ── Controls visibility ───────────────────────────────────────────────────
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);

  useEffect(() => {
    revealControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [revealControls]);

  // ── Camera + rAF loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) { onError('unsupported'); return; }

    const video   = videoRef.current!;
    const canvas  = canvasRef.current!;
    const aCanvas = analysisRef.current!;
    const ctx     = canvas.getContext('2d')!;
    const aCtx    = aCanvas.getContext('2d', { willReadFrequently: true })!;

    aCanvas.width  = ANALYSIS_W;
    aCanvas.height = ANALYSIS_H;

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    let aborted = false;

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

    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      if (video.readyState < 2) return;

      aCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const frame = aCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
      const curr  = frame.data;
      const prev  = prevFrameRef.current;
      if (!prev) { prevFrameRef.current = new Uint8ClampedArray(curr); return; }

      const W         = canvas.width;
      const H         = canvas.height;
      const scaleX    = W / ANALYSIS_W;
      const scaleY    = H / ANALYSIS_H;
      const threshold = 75 - (sensitivityRef.current / 100) * 70;
      const curMode   = modeRef.current;

      const motion: MotionPixel[] = [];
      for (let i = 0; i < curr.length; i += 4) {
        const diff = Math.abs(curr[i] - prev[i]) + Math.abs(curr[i+1] - prev[i+1]) + Math.abs(curr[i+2] - prev[i+2]);
        if (diff > threshold) {
          const idx = i / 4;
          motion.push({
            px: (ANALYSIS_W - 1 - (idx % ANALYSIS_W)) * scaleX,
            py: Math.floor(idx / ANALYSIS_W) * scaleY,
            intensity: Math.min(diff / 280, 1),
          });
        }
      }

      switch (curMode) {
        case 'ghost': renderGhost(ctx, W, H, motion, trailRef.current, scaleX, scaleY); break;
        case 'web':   renderWeb(ctx, W, H, motion);                                     break;
        case 'rain':  renderRain(ctx, W, H, motion);                                    break;
      }

      prevFrameRef.current = new Uint8ClampedArray(curr);
    }

    function renderGhost(
      ctx: CanvasRenderingContext2D,
      W: number, H: number,
      motion: MotionPixel[],
      trail: number,
      sx: number, sy: number,
    ) {
      const fadeAlpha = 0.35 - (trail / 100) * 0.3;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(0,0,0,${fadeAlpha})`;
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = 'lighter';
      const pw = sx + 1;
      const ph = sy + 1;

      for (const { px, py, intensity } of motion) {
        const alpha = 0.28 + intensity * 0.55;

        let r: number, g: number, b: number;
        if (intensity < 0.5) {
          const t = intensity * 2;
          r = Math.round(40  + t * 20);
          g = Math.round(100 + t * 100);
          b = 255;
        } else {
          const t = (intensity - 0.5) * 2;
          r = Math.round(60  + t * 195);
          g = Math.round(200 + t * 20);
          b = Math.round(255 - t * 175);
        }

        const shift = Math.max(0, (intensity - 0.35) / 0.65) * 12;
        if (shift > 0.8) {
          ctx.fillStyle = `rgba(255,30,30,${alpha * 0.55})`;
          ctx.fillRect(px - shift - 0.5, py - 0.5, pw, ph);
          ctx.fillStyle = `rgba(30,30,255,${alpha * 0.55})`;
          ctx.fillRect(px + shift - 0.5, py - 0.5, pw, ph);
        }

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(px - 0.5, py - 0.5, pw, ph);
      }
    }

    function renderWeb(ctx: CanvasRenderingContext2D, W: number, H: number, motion: MotionPixel[]) {
      if (!constellationRef.current) {
        const nodes: CNode[] = Array.from({ length: WEB_NODES }, () => ({
          nx: Math.random(),
          ny: Math.random(),
        }));
        const edges: CEdge[] = [];
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[i].nx - nodes[j].nx;
            const dy = nodes[i].ny - nodes[j].ny;
            if (Math.sqrt(dx * dx + dy * dy) < WEB_LINK_NORM) {
              edges.push({ a: i, b: j });
            }
          }
        }
        constellationRef.current = { nodes, edges };
      }

      const { nodes, edges } = constellationRef.current;
      const cellW = W / MASK_W;
      const cellH = H / MASK_H;
      const mask  = bodyMaskRef.current;

      const heal = 0.88 + (trailRef.current / 100) * 0.10;
      for (let i = 0; i < mask.length; i++) mask[i] *= heal;
      for (const { px, py, intensity } of motion) {
        const cx = Math.min(Math.floor(px / cellW), MASK_W - 1);
        const cy = Math.min(Math.floor(py / cellH), MASK_H - 1);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < MASK_W && ny >= 0 && ny < MASK_H) {
              mask[ny * MASK_W + nx] = Math.min(1, mask[ny * MASK_W + nx] + intensity * 0.7);
            }
          }
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      for (const { a, b } of edges) {
        const x1 = nodes[a].nx * W, y1 = nodes[a].ny * H;
        const x2 = nodes[b].nx * W, y2 = nodes[b].ny * H;
        ctx.strokeStyle = 'rgba(130,190,255,0.28)';
        ctx.lineWidth   = 0.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      for (const { nx, ny } of nodes) {
        ctx.fillStyle = 'rgba(180,220,255,0.75)';
        ctx.beginPath();
        ctx.arc(nx * W, ny * H, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      const edgeSoftness = 1.2 - (sensitivityRef.current / 100) * 0.7;
      ctx.globalCompositeOperation = 'source-over';
      for (let cy = 0; cy < MASK_H; cy++) {
        for (let cx = 0; cx < MASK_W; cx++) {
          const s = mask[cy * MASK_W + cx];
          if (s < 0.04) continue;
          ctx.fillStyle = `rgba(0,0,0,${Math.min(s * edgeSoftness, 1)})`;
          ctx.beginPath();
          ctx.arc(
            (cx + 0.5) * cellW,
            (cy + 0.5) * cellH,
            cellW * 0.85,
            0, Math.PI * 2,
          );
          ctx.fill();
        }
      }
    }

    function renderRain(ctx: CanvasRenderingContext2D, W: number, H: number, motion: MotionPixel[]) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(0, 0, W, H);

      const cellW = W / MASK_W;
      const cellH = H / MASK_H;
      const mask  = bodyMaskRef.current;

      for (let i = 0; i < mask.length; i++) mask[i] *= 0.94;

      for (const { px, py, intensity } of motion) {
        const cx = Math.min(Math.floor(px / cellW), MASK_W - 1);
        const cy = Math.min(Math.floor(py / cellH), MASK_H - 1);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < MASK_W && ny >= 0 && ny < MASK_H) {
              mask[ny * MASK_W + nx] = Math.min(1, mask[ny * MASK_W + nx] + intensity * 0.6);
            }
          }
        }
      }

      const dropsPerFrame = 5 + Math.round((trailRef.current / 100) * 35);
      for (let i = 0; i < dropsPerFrame; i++) {
        if (rainRef.current.length >= MAX_DROPS) break;
        rainRef.current.push({
          x:     Math.random() * W,
          y:     -8,
          vx:    (Math.random() - 0.5) * 0.5,
          vy:    3.5 + Math.random() * 3,
          alpha: 0.25 + Math.random() * 0.45,
          size:  0.5  + Math.random() * 0.7,
          r: 80, g: 150, b: 240,
        });
      }

      const alive: Drop[] = [];
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      for (const d of rainRef.current) {
        const nextY = d.y + d.vy;
        const cx    = Math.min(Math.max(Math.floor(d.x  / cellW), 0), MASK_W - 1);
        const cy    = Math.min(Math.max(Math.floor(nextY / cellH), 0), MASK_H - 1);

        if (mask[cy * MASK_W + cx] > 0.3) {
          d.alpha -= 0.04;
          if (d.alpha > 0) {
            alive.push(d);
            ctx.fillStyle = `rgba(${d.r},${d.g},${d.b},${d.alpha * 0.85})`;
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.size * 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }

        d.vy    += 0.2;
        d.y      = nextY;
        d.x     += d.vx;
        d.alpha -= 0.004;

        if (d.alpha <= 0 || d.y > H + 10) continue;
        alive.push(d);

        ctx.strokeStyle = `rgba(${d.r},${d.g},${d.b},${d.alpha})`;
        ctx.lineWidth   = d.size;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - Math.min(d.vy * 2, 18));
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
      rainRef.current = alive;
    }

    return () => {
      aborted = true;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={analysisRef} className="hidden" />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Live indicator — top left */}
      <div className="absolute top-5 left-5 pointer-events-none select-none">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-black/55 backdrop-blur-sm border border-white/[0.07]">
          <span className="block w-1.5 h-1.5 rounded-full bg-green-400/80
            shadow-[0_0_5px_rgba(74,222,128,0.6)]" />
          <span className="text-[9px] tracking-[0.25em] uppercase text-white/50">
            Live
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
        />
      </div>
    </div>
  );
}
