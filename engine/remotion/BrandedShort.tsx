import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  CalculateMetadataFunction,
} from "remotion";
import { SERIF, SANS } from "./fonts";

// ---------------------------------------------------------------------------
// Brand spec (the input). Defaults are a neutral demo palette.
// A real brief passes `theme` + `logo` + `scenes` via --props.
// ---------------------------------------------------------------------------

export interface BrandTheme {
  cream: string; // page background
  slate: string; // hero background, primary text
  teal: string; // pull-quote, accents
  gold: string; // italic emphasis, the truth block
  sage: string; // secondary text on dark
}

const DEFAULT_THEME: BrandTheme = {
  cream: "#f4f4f5",
  slate: "#18181b",
  teal: "#3f6f6a",
  gold: "#c2a45f",
  sage: "#8a8a94",
};

type Scene =
  | { type: "intro"; eyebrow?: string; headline: string; seconds: number }
  | { type: "statement"; eyebrow?: string; headline: string; seconds: number }
  | { type: "truth"; text: string; seconds: number }
  | { type: "list"; eyebrow?: string; items: string[]; seconds: number }
  | { type: "outro"; quote: string; signoff: string; seconds: number };

export interface BrandedShortProps {
  theme?: Partial<BrandTheme>;
  logo?: string;
  scenes: Scene[];
  // Per-platform render target. Defaults to 9:16 (1080x1920).
  width?: number;
  height?: number;
}

const FPS = 30;

// Sum scene durations (+ small tail) for length; honor per-platform width/height.
export const calculateBrandedShortMetadata: CalculateMetadataFunction<
  BrandedShortProps
> = ({ props }) => {
  const total = (props.scenes || []).reduce((a, s) => a + (s.seconds || 0), 0);
  return {
    durationInFrames: Math.ceil((total + 0.4) * FPS),
    width: props.width || 1080,
    height: props.height || 1920,
  };
};

// ---------------------------------------------------------------------------
// Motion helpers — calm, editorial, non-bouncy.
// ---------------------------------------------------------------------------

const useRise = (delay = 0, distance = 26) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, stiffness: 90, mass: 1 },
  });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)` };
};

// Gentle fade-out over the last ~10 frames of a scene so cuts breathe.
const useSceneFade = (sceneFrames: number) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [sceneFrames - 10, sceneFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

// A very soft, slow-drifting brand glow over a flat base. Keeps stills from feeling dead.
const SoftGlow: React.FC<{ base: string; glow: string; on: "light" | "dark" }> = ({
  base,
  glow,
  on,
}) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 90) * 12;
  const y = 42 + Math.cos(frame / 110) * 10;
  const strength = on === "dark" ? 0.28 : 0.16;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(60% 45% at ${x}% ${y}%, ${glow}${Math.round(
          strength * 255
        )
          .toString(16)
          .padStart(2, "0")} 0%, transparent 70%), ${base}`,
      }}
    />
  );
};

const GoldRule: React.FC<{ color: string; delay?: number; width?: number }> = ({
  color,
  delay = 6,
  width = 120,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 60 } });
  return (
    <div
      style={{
        height: 2,
        width: interpolate(s, [0, 1], [0, width]),
        background: color,
        borderRadius: 2,
        margin: "0 auto",
      }}
    />
  );
};

const Eyebrow: React.FC<{ text: string; color: string; delay?: number }> = ({
  text,
  color,
  delay = 2,
}) => {
  const r = useRise(delay, 14);
  return (
    <div
      style={{
        ...r,
        fontFamily: SANS,
        fontSize: 30,
        fontWeight: 500,
        letterSpacing: "0.34em",
        textTransform: "uppercase",
        color,
      }}
    >
      {text}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Scene components
// ---------------------------------------------------------------------------

const PAD = 110; // side padding, keeps text off the vertical edges

const Intro: React.FC<{ theme: BrandTheme; logo?: string; scene: Extract<Scene, { type: "intro" }> }> = ({
  theme,
  logo,
  scene,
}) => {
  const fade = useSceneFade(scene.seconds * FPS);
  const logoR = useRise(0, 0);
  const head = useRise(14, 30);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <SoftGlow base={theme.slate} glow={theme.teal} on="dark" />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: `0 ${PAD}px`,
          gap: 46,
        }}
      >
        {logo && (
          <Img
            src={logo}
            style={{ width: 150, height: 150, objectFit: "contain", opacity: logoR.opacity }}
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 30, alignItems: "center" }}>
          {scene.eyebrow && <Eyebrow text={scene.eyebrow} color={theme.gold} delay={6} />}
          <div
            style={{
              ...head,
              fontFamily: SERIF,
              fontSize: 96,
              fontWeight: 500,
              lineHeight: 1.14,
              color: theme.cream,
            }}
          >
            {scene.headline}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Statement: React.FC<{ theme: BrandTheme; scene: Extract<Scene, { type: "statement" }> }> = ({
  theme,
  scene,
}) => {
  const fade = useSceneFade(scene.seconds * FPS);
  const head = useRise(8, 30);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <SoftGlow base={theme.cream} glow={theme.gold} on="light" />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: `0 ${PAD}px`,
          gap: 34,
        }}
      >
        {scene.eyebrow && <Eyebrow text={scene.eyebrow} color={theme.teal} delay={2} />}
        <div
          style={{
            ...head,
            fontFamily: SERIF,
            fontSize: 104,
            fontWeight: 500,
            lineHeight: 1.16,
            color: theme.slate,
          }}
        >
          {scene.headline}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// The signature "truth block": gold left-rule, italic serif, an emphasis line.
const Truth: React.FC<{ theme: BrandTheme; scene: Extract<Scene, { type: "truth" }> }> = ({
  theme,
  scene,
}) => {
  const fade = useSceneFade(scene.seconds * FPS);
  const rule = useRise(2, 0);
  const body = useRise(12, 34);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <SoftGlow base={theme.cream} glow={theme.gold} on="light" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: `0 ${PAD}px` }}>
        <div
          style={{
            borderLeft: `6px solid ${theme.gold}`,
            paddingLeft: 46,
            textAlign: "left",
            maxWidth: 820,
            opacity: rule.opacity,
          }}
        >
          <div
            style={{
              ...body,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 92,
              fontWeight: 500,
              lineHeight: 1.22,
              color: theme.slate,
            }}
          >
            {scene.text}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const ListItem: React.FC<{ index: number; item: string; theme: BrandTheme }> = ({
  index,
  item,
  theme,
}) => {
  const r = useRise(10 + index * 9, 24);
  return (
    <div style={{ ...r, display: "flex", alignItems: "baseline", gap: 26 }}>
      <span
        style={{
          fontFamily: SERIF,
          fontSize: 48,
          fontWeight: 600,
          color: theme.gold,
          minWidth: 44,
        }}
      >
        {index + 1}
      </span>
      <span
        style={{
          fontFamily: SANS,
          fontSize: 52,
          fontWeight: 400,
          lineHeight: 1.24,
          color: theme.slate,
        }}
      >
        {item}
      </span>
    </div>
  );
};

const List: React.FC<{ theme: BrandTheme; scene: Extract<Scene, { type: "list" }> }> = ({
  theme,
  scene,
}) => {
  const fade = useSceneFade(scene.seconds * FPS);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <SoftGlow base={theme.cream} glow={theme.teal} on="light" />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          padding: `0 ${PAD}px`,
          gap: 40,
        }}
      >
        {scene.eyebrow && (
          <div style={{ marginBottom: 8 }}>
            <Eyebrow text={scene.eyebrow} color={theme.gold} delay={0} />
            <div style={{ marginTop: 22 }}>
              <GoldRule color={theme.gold} delay={4} width={160} />
            </div>
          </div>
        )}
        {scene.items.map((item, i) => (
          <ListItem key={i} index={i} item={item} theme={theme} />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ theme: BrandTheme; logo?: string; scene: Extract<Scene, { type: "outro" }> }> = ({
  theme,
  logo,
  scene,
}) => {
  const fade = useSceneFade(scene.seconds * FPS);
  const quote = useRise(6, 30);
  const sign = useRise(24, 18);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <SoftGlow base={theme.slate} glow={theme.teal} on="dark" />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: `0 ${PAD}px`,
          gap: 54,
        }}
      >
        <div
          style={{
            ...quote,
            fontFamily: SERIF,
            fontSize: 88,
            fontWeight: 500,
            lineHeight: 1.2,
            color: theme.cream,
            maxWidth: 840,
          }}
        >
          {scene.quote}
        </div>
        <GoldRule color={theme.gold} delay={18} width={120} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
          {logo && (
            <Img src={logo} style={{ width: 118, height: 118, objectFit: "contain", opacity: sign.opacity }} />
          )}
          <div
            style={{
              ...sign,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 56,
              color: theme.gold,
            }}
          >
            {scene.signoff}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Composition — lays scenes end to end by their durations.
// ---------------------------------------------------------------------------

export const BrandedShort: React.FC<BrandedShortProps> = ({ theme, logo, scenes }) => {
  const t: BrandTheme = { ...DEFAULT_THEME, ...(theme || {}) };
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: t.cream }}>
      {scenes.map((scene, i) => {
        const from = Math.round(cursor * FPS);
        const dur = Math.round(scene.seconds * FPS);
        cursor += scene.seconds;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            {scene.type === "intro" && <Intro theme={t} logo={logo} scene={scene} />}
            {scene.type === "statement" && <Statement theme={t} scene={scene} />}
            {scene.type === "truth" && <Truth theme={t} scene={scene} />}
            {scene.type === "list" && <List theme={t} scene={scene} />}
            {scene.type === "outro" && <Outro theme={t} logo={logo} scene={scene} />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
