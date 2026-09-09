/**
 * Voxshift brand mark + wordmark. "vox" (voice) as an ascending equalizer, the
 * last bar lifted and nudged forward — the *shift*. Palette from theme.ts
 * (brand 80 / 90). `tone="onDark"` renders white for the app header.
 */

const BRAND = '#4657D2';
const ACCENT = '#5B5FC7';

export function Logo({ size = 22, tone = 'brand' }: { size?: number; tone?: 'brand' | 'onDark' }) {
  const a = tone === 'onDark' ? 'currentColor' : BRAND;
  const b = tone === 'onDark' ? 'currentColor' : ACCENT;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" role="img">
      <rect x="1" y="14" width="4.5" height="13" rx="2.25" fill={a} />
      <rect x="7.5" y="10" width="4.5" height="17" rx="2.25" fill={a} />
      <rect x="14" y="6" width="4.5" height="21" rx="2.25" fill={a} />
      <rect x="21.5" y="1" width="4.5" height="16" rx="2.25" fill={b} />
    </svg>
  );
}

export function Wordmark({
  tone = 'brand',
  size = 20,
}: {
  tone?: 'brand' | 'onDark';
  size?: number;
}) {
  const text = tone === 'onDark' ? '#ffffff' : '#242424';
  const accent = tone === 'onDark' ? 'rgba(255,255,255,0.88)' : ACCENT;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <Logo size={size + 2} tone={tone} />
      <span
        style={{
          fontSize: size,
          fontWeight: 600,
          letterSpacing: '-0.015em',
          color: text,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          lineHeight: 1,
        }}
      >
        vox<span style={{ color: accent, fontWeight: 400 }}>shift</span>
      </span>
    </span>
  );
}
