'use client';

import type { VisualMode } from './GhostCamera';

const MODES: { id: VisualMode; label: string }[] = [
  { id: 'ghost', label: 'Ghost' },
  { id: 'rain',  label: 'Rain'  },
];

interface ControlsProps {
  sensitivity: number;
  trailLength: number;
  mode: VisualMode;
  onSensitivityChange: (v: number) => void;
  onTrailLengthChange: (v: number) => void;
  onModeChange: (m: VisualMode) => void;
  onStop: () => void;
  onInteract: () => void;
}

export default function Controls({
  sensitivity, trailLength, mode,
  onSensitivityChange, onTrailLengthChange, onModeChange,
  onStop, onInteract,
}: ControlsProps) {
  return (
    <div
      className="w-full px-6 pb-10 pt-16
        bg-gradient-to-t from-black/95 via-black/60 to-transparent"
      onPointerMove={onInteract}
      onPointerDown={onInteract}
    >
      <div className="max-w-sm mx-auto flex flex-col gap-7">

        {/* ── Mode selector ── */}
        <div className="flex items-center justify-between">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => { onModeChange(m.id); onInteract(); }}
              aria-label={`${m.label} mode`}
              aria-pressed={mode === m.id}
              className={`
                flex flex-col items-center gap-2
                min-w-[44px] min-h-[44px] justify-center px-4
                cursor-pointer focus:outline-none
                transition-all duration-200
                ${mode === m.id ? 'text-white' : 'text-white/25 hover:text-white/55'}
              `}
            >
              <span className="text-[10px] tracking-[0.18em] uppercase">{m.label}</span>
              <span className={`block h-px rounded-full transition-all duration-300
                ${mode === m.id ? 'w-5 bg-white' : 'w-0 bg-white/0'}`}
              />
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.06]" />

        {/* ── Sliders ── */}
        <div className="flex flex-col gap-6">
          <Slider
            label="Sensitivity"
            hint={mode === 'rain' ? 'motion threshold' : 'detection level'}
            value={sensitivity}
            onChange={onSensitivityChange}
            onInteract={onInteract}
          />
          <Slider
            label="Trail"
            hint={mode === 'rain' ? 'rain density' : 'ghost persistence'}
            value={trailLength}
            onChange={onTrailLengthChange}
            onInteract={onInteract}
          />
        </div>

        {/* ── Exit ── */}
        <div className="flex justify-center pt-1">
          <button
            onClick={onStop}
            className="flex items-center gap-3 min-h-[44px] px-6
              text-[10px] tracking-[0.28em] uppercase
              text-white/25 hover:text-white/65 active:text-white
              transition-colors duration-200 cursor-pointer focus:outline-none"
            aria-label="Stop camera"
          >
            <span className="block h-px w-3 bg-current transition-all duration-300 group-hover:w-5" />
            Exit
            <span className="block h-px w-3 bg-current transition-all duration-300 group-hover:w-5" />
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Slider ────────────────────────────────────────────────────────────────────
function Slider({ label, hint, value, onChange, onInteract }: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  onInteract: () => void;
}) {
  const fillStyle = {
    background: `linear-gradient(to right,
      rgba(255,255,255,0.65) 0%,
      rgba(255,255,255,0.65) ${value}%,
      rgba(255,255,255,0.10) ${value}%,
      rgba(255,255,255,0.10) 100%)`,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[10px] tracking-[0.22em] uppercase text-white/55">{label}</span>
          <span className="text-[9px] tracking-[0.12em] text-white/20">{hint}</span>
        </div>
        <span className="text-[10px] tabular-nums text-white/35">{value}</span>
      </div>
      <div className="py-2 -my-2">
        <input
          type="range" min={0} max={100} value={value}
          onChange={e => onChange(Number(e.target.value))}
          onPointerDown={onInteract}
          aria-label={label}
          style={fillStyle}
          className="
            w-full h-[3px] rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:h-[18px]
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.3),0_0_10px_rgba(255,255,255,0.3)]
            [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150
            [&::-webkit-slider-thumb]:active:scale-110
            [&::-moz-range-thumb]:w-[18px] [&::-moz-range-thumb]:h-[18px]
            [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white
            [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer
          "
        />
      </div>
    </div>
  );
}
