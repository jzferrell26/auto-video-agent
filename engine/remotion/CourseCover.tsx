import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { SERIF, SANS } from "./fonts";
import { BrandTheme } from "./BrandedShort";

// Static branded course cover (GHL product imageUrl). Rendered as a still.

const DEFAULT_THEME: BrandTheme = {
  cream: "#f4f4f5",
  slate: "#18181b",
  teal: "#3f6f6a",
  gold: "#c2a45f",
  sage: "#8a8a94",
};

export type CourseCoverProps = {
  theme?: Partial<BrandTheme>;
  logo?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
};

const Glow: React.FC<{ base: string; glow: string }> = ({ base, glow }) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 90) * 8;
  const y = 44 + Math.cos(frame / 110) * 6;
  return <AbsoluteFill style={{ background: `radial-gradient(58% 46% at ${x}% ${y}%, ${glow}40 0%, transparent 70%), ${base}` }} />;
};

export const CourseCover: React.FC<CourseCoverProps> = ({ theme, logo, eyebrow, title, subtitle }) => {
  const t: BrandTheme = { ...DEFAULT_THEME, ...(theme || {}) };
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200, stiffness: 90 } });
  const rule = interpolate(s, [0, 1], [0, 180]);
  return (
    <AbsoluteFill style={{ backgroundColor: t.slate }}>
      <Glow base={t.slate} glow={t.teal} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", padding: "0 160px", gap: 40 }}>
        {logo && <Img src={logo} style={{ width: 128, height: 128, objectFit: "contain", opacity: s }} />}
        {eyebrow && (
          <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 500, letterSpacing: "0.32em", textTransform: "uppercase", color: t.gold, opacity: s }}>
            {eyebrow}
          </div>
        )}
        <div style={{ fontFamily: SERIF, fontSize: 118, fontWeight: 500, lineHeight: 1.08, color: t.cream, maxWidth: 1400, opacity: s }}>
          {title}
        </div>
        <div style={{ height: 2, width: rule, background: t.gold, borderRadius: 2 }} />
        {subtitle && (
          <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 46, color: t.sage, maxWidth: 1100, opacity: s }}>
            {subtitle}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
