// SplicedShort: a vertical talking-head short assembled from frame ranges of one or more
// takes. It reframes 16:9 footage to 9:16 per segment, hides take-to-take cuts behind
// jump zooms and punch-ins (each punch-in owns its whoosh), runs word-level captions, and
// cuts away to full-frame motion scenes: a title slam, an illustrative chat, a checklist,
// a task-overload build-up, screen footage with focus rings, a stat, a pull quote, and an
// end card.
//
// Every color, font, word of copy, and media path arrives as a prop. Build the segment
// list with engine/pipeline/splice-plan.mjs so source and output time stay in one ledger.
// Sound effects are optional: without `whooshSrc` (or `sfx`) the short renders silently
// apart from the footage audio.
import { loadFont as loadBarlow } from "@remotion/google-fonts/Barlow";
import { loadFont as loadBarlowCondensed } from "@remotion/google-fonts/BarlowCondensed";
import React from "react";
import {
  AbsoluteFill,
  Audio,
  CalculateMetadataFunction,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const barlow = loadBarlow("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const barlowCondensed = loadBarlowCondensed("normal", {
  weights: ["600", "700", "800", "900"],
  subsets: ["latin"],
});

export type SplicedShortTheme = {
  background: string;
  surface: string;
  foreground: string;
  accent: string;
  muted: string;
  success: string;
  fontFamily: string;
  displayFontFamily: string;
};

// Neutral defaults so a missing theme still renders. Real brands arrive via `theme`.
const DEFAULT_THEME: SplicedShortTheme = {
  background: "#111111",
  surface: "#1f1f23",
  foreground: "#f4f4f5",
  accent: "#3f6f6a",
  muted: "#8a8a94",
  success: "#2e9d5b",
  fontFamily: barlow.fontFamily,
  displayFontFamily: barlowCondensed.fontFamily,
};

export type SplicedSegment = {
  src: string;
  /** First source frame kept, on the composition's fps grid. */
  fromFrame: number;
  /** Source frame the segment stops before (exclusive). */
  toFrame: number;
  /** Horizontal center of the 9:16 window, normalized to the source width. */
  centerX?: number;
  /** Segment zoom. Alternating values between takes turns a cut into a deliberate jump. */
  zoom?: number;
  volume?: number;
};

export type SplicedPunchIn = {
  atMs: number;
  durMs: number;
  scale: number;
  ramp?: "cut" | "ease";
  /** Zoom target, normalized to the output frame. */
  anchorX?: number;
  anchorY?: number;
  /** Punch-ins fire the whoosh by default; the visual and the sound are one event. */
  whoosh?: boolean;
};

export type SplicedCaption = { word: string; startMs: number; endMs: number; emphasis?: boolean };

type CutawayBase = {
  atMs: number;
  durMs: number;
  /** Cutaways enter with the whoosh unless this is false. */
  whoosh?: boolean;
  captionY?: number;
  hideCaptions?: boolean;
};

export type SplicedRing = {
  atMs: number;
  durMs?: number;
  x: number;
  y: number;
  r: number;
  label?: string;
  /** Anchor the label at the ring's left or right edge when the ring sits near a card edge. */
  labelAlign?: "center" | "left" | "right";
};

export type SplicedCutaway =
  | (CutawayBase & { type: "title"; eyebrow?: string; title: string; subtitle?: string })
  | (CutawayBase & {
      type: "chat";
      appName: string;
      /** Small line under the app name, for example "online". */
      status?: string;
      label?: string;
      messages: { from: "sent" | "received"; text: string; atMs: number; typingMs?: number; done?: boolean }[];
    })
  | (CutawayBase & {
      type: "checklist";
      eyebrow?: string;
      title: string;
      items: { text: string; atMs: number }[];
      footnote?: string;
    })
  | (CutawayBase & {
      type: "overload";
      eyebrow?: string;
      centerLabel: string;
      tasks: string[];
      fromMs: number;
      toMs: number;
      counterLabel?: string;
    })
  | (CutawayBase & {
      type: "clip";
      src: string;
      /** Source frame the clip starts on. */
      sourceFrom: number;
      crop: { x: number; y: number; width: number; height: number };
      sourceWidth?: number;
      sourceHeight?: number;
      eyebrow?: string;
      title?: string;
      badge?: string;
      rings?: SplicedRing[];
    })
  | (CutawayBase & { type: "stat"; eyebrow?: string; value: string; label: string; sublabel?: string })
  | (CutawayBase & { type: "cta"; eyebrow?: string; title: string; url: string; button?: string })
  | (CutawayBase & { type: "quote"; eyebrow?: string; quote: string; attribution?: string; note?: string });

export type SplicedKicker = { atMs: number; durMs: number; text: string; y?: number; rotate?: number };

export type SplicedShortProps = {
  theme?: Partial<SplicedShortTheme>;
  segments: SplicedSegment[];
  sourceWidth?: number;
  sourceHeight?: number;
  /** Zoom applied to every face shot, toward a point on the output's vertical center line. */
  baseZoom?: number;
  baseOriginY?: number;
  /** Slow push across each segment, as a fraction of scale (0.03 = 3%). */
  drift?: number;
  punchIns?: SplicedPunchIn[];
  captions?: SplicedCaption[];
  /** Vertical center of captions over face shots, in output pixels. */
  captionY?: number;
  wordsPerPage?: number;
  cutaways?: SplicedCutaway[];
  kickers?: SplicedKicker[];
  nameTag?: { name: string; title?: string; atMs: number; durMs: number };
  sfx?: { src: string; atMs: number; volume?: number }[];
  /** Optional whoosh sound under `public/`. Without it, punch-ins and cutaways are silent. */
  whooshSrc?: string;
  whooshVolume?: number;
  /** Hold after the last spoken segment, for an end card. */
  tailMs?: number;
  /**
   * Portrait only, and entirely optional. Fractions of the frame height that graphics, low
   * captions and the name tag stay between, for example to keep clear of a platform's
   * overlay controls. Leave it out and the generic layout below applies. When `bottom` is
   * given, low captions hang just under that line.
   */
  safeArea?: { top?: number; bottom?: number };
  width?: number;
  height?: number;
};

const FPS = 30;
// Joins sit in silences: a one-frame ramp in keeps word onsets crisp, two frames out kills clicks.
const AUDIO_FADE_IN_FRAMES = 1;
const AUDIO_FADE_OUT_FRAMES = 2;

const segmentFrames = (segment: SplicedSegment) => Math.max(0, segment.toFrame - segment.fromFrame);

export const calculateSplicedShortMetadata: CalculateMetadataFunction<SplicedShortProps> = ({ props }) => {
  const spoken = (props.segments ?? []).reduce((sum, segment) => sum + segmentFrames(segment), 0);
  const tail = Math.round(((props.tailMs ?? 0) * FPS) / 1000);
  const cutawayEnd = Math.max(0, ...(props.cutaways ?? []).map((c) => Math.round(((c.atMs + c.durMs) * FPS) / 1000)));
  return {
    durationInFrames: Math.max(1, spoken + tail, cutawayEnd),
    fps: FPS,
    width: props.width || 1080,
    height: props.height || 1920,
  };
};

const resolveSrc = (src: string): string => {
  if (/^(https?:|data:|file:)/.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) return src;
  return staticFile(src);
};

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
/** Layout unit: 1 at 1080 px on the frame's short side, so 9:16 and 16:9 share sizes. */
const unitOf = (W: number, H: number) => Math.min(W, H) / 1080;
const msToFrame = (ms: number, fps: number) => Math.round((ms * fps) / 1000);
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Scale and origin of the punch-in active at an absolute frame. */
function punchAt(frame: number, fps: number, punchIns: SplicedPunchIn[]) {
  for (const punch of punchIns) {
    const from = msToFrame(punch.atMs, fps);
    const to = from + Math.max(1, msToFrame(punch.durMs, fps));
    if (frame < from || frame >= to) continue;
    let scale = Math.max(1, punch.scale);
    if (punch.ramp === "ease") {
      const rampIn = Math.min(5, Math.floor((to - from) / 3));
      const rampOut = Math.min(4, Math.floor((to - from) / 3));
      scale = interpolate(frame, [from, from + rampIn, to - rampOut, to], [1, scale, scale, 1], {
        ...CLAMP,
        easing: Easing.out(Easing.cubic),
      });
    }
    return { scale, x: clamp(punch.anchorX ?? 0.5, 0, 1), y: clamp(punch.anchorY ?? 0.5, 0, 1) };
  }
  return { scale: 1, x: 0.5, y: 0.5 };
}

const FaceShot: React.FC<{
  segment: SplicedSegment;
  outFrom: number;
  props: SplicedShortProps;
  theme: SplicedShortTheme;
}> = ({ segment, outFrom, props, theme }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = useVideoConfig();
  const len = segmentFrames(segment);
  const sW = props.sourceWidth ?? 1920;
  const sH = props.sourceHeight ?? 1080;
  const k = Math.max(W / sW, H / sH);
  const vw = sW * k;
  const vh = sH * k;
  const left = clamp(W / 2 - (segment.centerX ?? 0.5) * vw, W - vw, 0);
  const top = (H - vh) / 2;
  const drift = 1 + (props.drift ?? 0) * (frame / Math.max(1, len - 1));
  const zoom = (props.baseZoom ?? 1) * (segment.zoom ?? 1) * drift;
  const punch = punchAt(outFrom + frame, fps, props.punchIns ?? []);
  const gain = segment.volume ?? 1;
  const fade = (f: number) =>
    gain * interpolate(f, [0, AUDIO_FADE_IN_FRAMES, len - AUDIO_FADE_OUT_FRAMES, len], [0, 1, 1, 0], CLAMP);

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: theme.background }}>
      <AbsoluteFill style={{ transform: `scale(${punch.scale})`, transformOrigin: `${punch.x * 100}% ${punch.y * 100}%` }}>
        <AbsoluteFill
          style={{ transform: `scale(${zoom})`, transformOrigin: `50% ${clamp(props.baseOriginY ?? 0.5, 0, 1) * 100}%` }}
        >
          <OffthreadVideo
            src={resolveSrc(segment.src)}
            trimBefore={segment.fromFrame}
            trimAfter={segment.toFrame}
            volume={fade}
            style={{ position: "absolute", left, top, width: vw, height: vh }}
          />
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- captions

type CaptionPage = { words: SplicedCaption[]; startMs: number; endMs: number };

/** Pages break on the word budget, on sentence punctuation, and on real pauses. */
export function paginateCaptions(captions: SplicedCaption[], perPage: number): CaptionPage[] {
  const pages: SplicedCaption[][] = [];
  let current: SplicedCaption[] = [];
  for (const word of captions) {
    const prev = current[current.length - 1];
    const brk = current.length >= perPage || (prev && (word.startMs - prev.endMs > 450 || /[.?!,]$/.test(prev.word)));
    if (brk && current.length) {
      pages.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) pages.push(current);
  return pages.map((words, i) => {
    const next = pages[i + 1];
    const last = words[words.length - 1];
    const gapEnd = last.endMs + 350;
    return {
      words,
      startMs: words[0].startMs,
      endMs: next && next[0].startMs - last.endMs < 700 ? next[0].startMs : gapEnd,
    };
  });
}

const Captions: React.FC<{ props: SplicedShortProps; theme: SplicedShortTheme }> = ({ props, theme }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = useVideoConfig();
  const pages = React.useMemo(
    () => paginateCaptions(props.captions ?? [], props.wordsPerPage ?? 3),
    [props.captions, props.wordsPerPage]
  );
  const t = (frame * 1000) / fps;
  const cutaway = (props.cutaways ?? []).find((c) => t >= c.atMs && t < c.atMs + c.durMs);
  if (cutaway?.hideCaptions) return null;
  const page = pages.find((p) => t >= p.startMs && t < p.endMs);
  if (!page) return null;
  const u = unitOf(W, H);
  const landscape = W > H;
  // With a safe area, low captions hang just under the band.
  const hang = Boolean(cutaway) && !landscape && cutaway?.captionY === undefined && props.safeArea?.bottom != null;
  const lowY = hang ? Math.min((props.safeArea?.bottom ?? 0) + CAPTION_HANG_GAP, 0.96) : 0.7;
  const y = cutaway
    ? cutaway.captionY ?? H * (landscape ? 0.9 : lowY)
    : props.captionY ?? H * (landscape ? 0.87 : 0.27);
  // Low captions share height with the platforms' right-hand action buttons, so they get a
  // narrower box that stops short of that column. High captions over the face use the full width.
  const box = landscape
    ? { left: W * 0.1, width: W * 0.8 }
    : y > H * 0.5
      ? { left: W * 0.07, width: W * 0.76 }
      : { left: W * 0.06, width: W * 0.88 };
  const active = [...page.words].reverse().find((w) => t >= w.startMs);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: box.left,
          width: box.width,
          top: y,
          transform: hang ? "translateY(-100%)" : "translateY(-50%)",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: `${14 * u}px ${18 * u}px`,
        }}
      >
        {page.words.map((word, i) => {
          const isActive = word === active;
          const pop = spring({ frame: frame - msToFrame(word.startMs, fps), fps, config: { damping: 14, mass: 0.5 } });
          const scale = isActive ? interpolate(pop, [0, 1], [0.86, 1.06]) : 1;
          return (
            <span
              key={`${word.startMs}-${i}`}
              style={{
                fontFamily: theme.displayFontFamily,
                fontWeight: 900,
                fontSize: 96 * u,
                lineHeight: 1.05,
                textTransform: "uppercase",
                color: word.emphasis && !isActive ? theme.accent : theme.foreground,
                backgroundColor: isActive ? theme.accent : "transparent",
                padding: `${2 * u}px ${14 * u}px`,
                borderRadius: 14 * u,
                WebkitTextStroke: isActive ? undefined : `${10 * u}px #000`,
                paintOrder: "stroke fill",
                textShadow: `0 ${6 * u}px ${18 * u}px rgba(0,0,0,0.55)`,
                transform: `scale(${scale})`,
                display: "inline-block",
              }}
            >
              {word.word.replace(/[,.]$/, "")}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- shared bits

const Chip: React.FC<{ text: string; theme: SplicedShortTheme; tone?: "accent" | "light" | "dark"; size?: number }> = ({
  text,
  theme,
  tone = "accent",
  size = 40,
}) => {
  const { width: W, height: H } = useVideoConfig();
  const u = unitOf(W, H);
  const bg = tone === "accent" ? theme.accent : tone === "light" ? theme.foreground : theme.surface;
  const fg = tone === "light" ? theme.background : theme.foreground;
  return (
    <div
      style={{
        alignSelf: "center",
        backgroundColor: bg,
        color: fg,
        fontFamily: theme.displayFontFamily,
        fontWeight: 800,
        fontSize: size * u,
        letterSpacing: 4 * u,
        textTransform: "uppercase",
        padding: `${8 * u}px ${22 * u}px`,
      }}
    >
      {text}
    </div>
  );
};

const SafeAreaContext = React.createContext<SplicedShortProps["safeArea"]>(undefined);

/** Generic portrait layout: graphics sit between these fractions of the height. */
const DEFAULT_BAND = { top: 0.1, bottom: 0.7 };
/** A hanging caption's lower edge sits this far (fraction of height) under `safeArea.bottom`. */
const CAPTION_HANG_GAP = 0.04;

/** Portrait graphics band. Studio and --props skip validation, so keep at least 15% of height. */
const portraitBand = (H: number, safe: SplicedShortProps["safeArea"]) => {
  const top = Math.min(0.4, Math.max(0, safe?.top ?? DEFAULT_BAND.top));
  const bottom = Math.min(0.95, Math.max(top + 0.15, safe?.bottom ?? DEFAULT_BAND.bottom));
  return { top: H * top, bottom: H * bottom };
};

/** The content zone keeps graphics clear of platform chrome above and the caption band below. */
const useZone = () => {
  const { width: W, height: H } = useVideoConfig();
  const safe = React.useContext(SafeAreaContext);
  // Portrait keeps graphics between the platform chrome and the low caption band; landscape
  // has no chrome, so graphics take the frame above a bottom caption band.
  return W > H
    ? { W, H, u: unitOf(W, H), top: H * 0.08, bottom: H * 0.8 }
    : { W, H, u: unitOf(W, H), ...portraitBand(H, safe) };
};

const enter = (frame: number, fps: number, delayFrames = 0) =>
  spring({ frame: frame - delayFrames, fps, config: { damping: 16, mass: 0.6 } });

const Check: React.FC<{ size: number; color: string; progress: number }> = ({ size, color, progress }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path
      d="M5 12.5l4.2 4.2L19 7"
      fill="none"
      stroke={color}
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={24}
      strokeDashoffset={24 * (1 - progress)}
    />
  </svg>
);

// ---------------------------------------------------------------- scenes

const TitleScene: React.FC<{ c: Extract<SplicedCutaway, { type: "title" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const lines = c.title.split("\n");
  const bar = interpolate(frame, [6, 16], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  // Shrink long titles to fit: about 0.46 em per condensed capital, and the stack inside the zone.
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const fontSize = Math.min(
    230 * z.u,
    (z.W * 0.9) / (longest * 0.46),
    ((z.bottom - z.top) * 0.62) / (lines.length * 0.88)
  );
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        width: z.W,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26 * z.u,
      }}
    >
      {c.eyebrow ? (
        <div style={{ opacity: enter(frame, fps), transform: `translateY(${(1 - enter(frame, fps)) * 30}px)` }}>
          <Chip text={c.eyebrow} theme={theme} />
        </div>
      ) : null}
      {lines.map((line, i) => {
        const p = enter(frame, fps, 2 + i * 3);
        return (
          <div
            key={i}
            style={{
              fontFamily: theme.displayFontFamily,
              fontWeight: 900,
              fontSize,
              lineHeight: 0.88,
              color: theme.foreground,
              textTransform: "uppercase",
              letterSpacing: -2 * z.u,
              transform: `translateY(${(1 - p) * 120 * z.u}px) scale(${interpolate(p, [0, 1], [1.25, 1])})`,
              opacity: p,
            }}
          >
            {line}
          </div>
        );
      })}
      <div style={{ width: z.W * 0.6 * bar, height: 14 * z.u, backgroundColor: theme.accent }} />
      {c.subtitle ? (
        <div
          style={{
            fontFamily: theme.fontFamily,
            fontWeight: 600,
            fontSize: 50 * z.u,
            color: theme.foreground,
            opacity: interpolate(frame, [10, 18], [0, 0.92], CLAMP),
            textAlign: "center",
            maxWidth: z.W * 0.94,
          }}
        >
          {c.subtitle}
        </div>
      ) : null}
    </div>
  );
};

const TypingDots: React.FC<{ frame: number; color: string; size: number }> = ({ frame, color, size }) => (
  <div style={{ display: "flex", gap: size * 0.6 }}>
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        style={{
          width: size,
          height: size,
          borderRadius: size,
          backgroundColor: color,
          transform: `translateY(${Math.sin((frame + i * 4) / 3) * size * 0.35}px)`,
          opacity: 0.85,
        }}
      />
    ))}
  </div>
);

const ChatScene: React.FC<{ c: Extract<SplicedCutaway, { type: "chat" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const t = (frame * 1000) / fps;
  const phoneW = 700 * z.u;
  // A wide frame has a short content zone, so the phone uses nearly all of it.
  const phoneH = (z.bottom - z.top) * (z.W > z.H ? 0.97 : 0.74);
  const p = enter(frame, fps);
  return (
    <div
      style={{
        position: "absolute",
        left: (z.W - phoneW) / 2,
        top: z.top + (z.bottom - z.top - phoneH) / 2,
        width: phoneW,
        height: phoneH,
        borderRadius: 70 * z.u,
        border: `${14 * z.u}px solid ${theme.surface}`,
        backgroundColor: "#0b0c0e",
        boxShadow: `0 ${40 * z.u}px ${120 * z.u}px rgba(0,0,0,0.6)`,
        overflow: "hidden",
        transform: `translateY(${(1 - p) * 160 * z.u}px) rotate(${(1 - p) * -4}deg)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22 * z.u,
          padding: `${44 * z.u}px ${36 * z.u}px ${26 * z.u}px`,
          borderBottom: `${2 * z.u}px solid ${theme.surface}`,
        }}
      >
        <div
          style={{
            width: 76 * z.u,
            height: 76 * z.u,
            borderRadius: 76 * z.u,
            backgroundColor: theme.accent,
            color: theme.foreground,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: theme.displayFontFamily,
            fontWeight: 900,
            fontSize: 44 * z.u,
          }}
        >
          {c.appName.slice(0, 1).toUpperCase()}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: theme.fontFamily, fontWeight: 700, fontSize: 40 * z.u, color: theme.foreground }}>
            {c.appName}
          </div>
          {c.status ? (
            <div style={{ fontFamily: theme.fontFamily, fontWeight: 500, fontSize: 28 * z.u, color: theme.muted }}>
              {c.status}
            </div>
          ) : null}
        </div>
        {c.label ? (
          <div style={{ marginLeft: "auto" }}>
            <Chip text={c.label} theme={theme} tone="dark" size={24} />
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 26 * z.u, padding: 34 * z.u }}>
        {c.messages.map((m, i) => {
          const typingFrom = m.atMs - (m.typingMs ?? 0);
          if (t < typingFrom) return null;
          const mine = m.from === "sent";
          const typing = t < m.atMs;
          const pop = spring({ frame: frame - msToFrame(m.atMs, fps), fps, config: { damping: 13, mass: 0.5 } });
          return (
            <div
              key={i}
              style={{
                alignSelf: mine ? "flex-end" : "flex-start",
                maxWidth: "82%",
                backgroundColor: mine ? theme.accent : theme.surface,
                color: theme.foreground,
                borderRadius: 34 * z.u,
                padding: typing ? `${26 * z.u}px ${30 * z.u}px` : `${22 * z.u}px ${30 * z.u}px`,
                fontFamily: theme.fontFamily,
                fontWeight: 600,
                fontSize: 52 * z.u,
                lineHeight: 1.18,
                transform: typing ? undefined : `scale(${interpolate(pop, [0, 1], [0.7, 1])})`,
                transformOrigin: mine ? "100% 100%" : "0% 100%",
                display: "flex",
                alignItems: "center",
                gap: 16 * z.u,
              }}
            >
              {typing ? (
                <TypingDots frame={frame} color={theme.muted} size={16 * z.u} />
              ) : (
                <>
                  {m.done ? (
                    <div
                      style={{
                        width: 58 * z.u,
                        height: 58 * z.u,
                        flex: "none",
                        borderRadius: 58 * z.u,
                        backgroundColor: theme.success,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Check
                        size={44 * z.u}
                        color={theme.foreground}
                        progress={interpolate(frame - msToFrame(m.atMs, fps), [2, 10], [0, 1], CLAMP)}
                      />
                    </div>
                  ) : null}
                  <span>{m.text}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ChecklistScene: React.FC<{ c: Extract<SplicedCutaway, { type: "checklist" }>; theme: SplicedShortTheme }> = ({
  c,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const t = (frame * 1000) / fps;
  const box = 84 * z.u;
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        left: (z.W - Math.min(z.W * 0.84, 920 * z.u)) / 2,
        width: Math.min(z.W * 0.84, 920 * z.u),
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 40 * z.u,
      }}
    >
      {c.eyebrow ? <Chip text={c.eyebrow} theme={theme} /> : null}
      <div
        style={{
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 120 * z.u,
          lineHeight: 0.95,
          color: theme.foreground,
          textTransform: "uppercase",
          textAlign: "center",
          opacity: enter(frame, fps),
        }}
      >
        {c.title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 30 * z.u, marginTop: 10 * z.u }}>
        {c.items.map((item, i) => {
          const on = t >= item.atMs;
          const f = frame - msToFrame(item.atMs, fps);
          const p = on ? enter(f, fps) : 0;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 30 * z.u,
                padding: `${22 * z.u}px ${28 * z.u}px`,
                backgroundColor: theme.surface,
                opacity: on ? 1 : 0.28,
                transform: `translateX(${(1 - p) * -60 * z.u}px)`,
              }}
            >
              <div
                style={{
                  width: box,
                  height: box,
                  flex: "none",
                  border: `${6 * z.u}px solid ${on ? theme.accent : theme.muted}`,
                  backgroundColor: on ? theme.accent : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Check size={box * 0.8} color={theme.foreground} progress={on ? interpolate(f, [1, 9], [0, 1], CLAMP) : 0} />
              </div>
              <div
                style={{
                  fontFamily: theme.displayFontFamily,
                  fontWeight: 800,
                  fontSize: 70 * z.u,
                  color: theme.foreground,
                  textTransform: "uppercase",
                }}
              >
                {item.text}
              </div>
            </div>
          );
        })}
      </div>
      {c.footnote ? (
        <div style={{ fontFamily: theme.fontFamily, fontWeight: 500, fontSize: 34 * z.u, color: theme.muted, textAlign: "center" }}>
          {c.footnote}
        </div>
      ) : null}
    </div>
  );
};

const OverloadScene: React.FC<{ c: Extract<SplicedCutaway, { type: "overload" }>; theme: SplicedShortTheme }> = ({
  c,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const t = (frame * 1000) / fps;
  const n = c.tasks.length;
  const shown = clamp(Math.floor(interpolate(t, [c.fromMs, c.toMs], [0, n], CLAMP)), 0, n);
  const load = shown / Math.max(1, n);
  const cx = z.W / 2;
  const cy = z.top + (z.bottom - z.top) * 0.45;
  const rx = z.W * 0.38;
  const ry = (z.bottom - z.top) * 0.31;
  const shake = Math.sin(frame * 1.9) * load * load * 10 * z.u;
  const core = 300 * z.u * (1 + 0.06 * Math.sin(frame / 2.2) * load);
  return (
    <>
      {c.eyebrow ? (
        <div style={{ position: "absolute", top: z.top, width: z.W, display: "flex", justifyContent: "center" }}>
          <Chip text={c.eyebrow} theme={theme} />
        </div>
      ) : null}
      {c.tasks.slice(0, shown).map((task, i) => {
        // Golden-angle spiral, squashed into the content zone, so chips never stack exactly.
        const angle = i * 2.39996;
        const radius = 0.5 + 0.5 * Math.sqrt((i + 1) / n);
        const x = cx + Math.cos(angle) * rx * radius;
        const y = cy + Math.sin(angle) * ry * radius;
        const appearMs = c.fromMs + ((c.toMs - c.fromMs) * i) / n;
        const p = spring({ frame: frame - msToFrame(appearMs, fps), fps, config: { damping: 12, mass: 0.45 } });
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              transform: `translate(-50%, -50%) scale(${p}) rotate(${((i % 5) - 2) * 3}deg)`,
              backgroundColor: i % 3 === 0 ? theme.foreground : theme.surface,
              color: i % 3 === 0 ? theme.background : theme.foreground,
              border: `${3 * z.u}px solid ${theme.muted}`,
              fontFamily: theme.displayFontFamily,
              fontWeight: 800,
              fontSize: 40 * z.u,
              textTransform: "uppercase",
              padding: `${10 * z.u}px ${20 * z.u}px`,
              whiteSpace: "nowrap",
            }}
          >
            {task}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: cx - core / 2 + shake,
          top: cy - core / 2,
          width: core,
          height: core,
          borderRadius: core,
          backgroundColor: load > 0.6 ? theme.accent : theme.surface,
          border: `${8 * z.u}px solid ${theme.foreground}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 76 * z.u,
          lineHeight: 0.95,
          color: theme.foreground,
          textTransform: "uppercase",
          boxShadow: `0 0 ${80 * load * z.u}px ${theme.accent}`,
        }}
      >
        {c.centerLabel}
      </div>
      {c.counterLabel && shown > 1 ? (
        <div
          style={{
            position: "absolute",
            top: z.bottom - 105 * z.u,
            width: z.W,
            textAlign: "center",
            fontFamily: theme.displayFontFamily,
            fontWeight: 900,
            fontSize: 100 * z.u,
            color: theme.foreground,
            textTransform: "uppercase",
            WebkitTextStroke: `${8 * z.u}px #000`,
            paintOrder: "stroke fill",
          }}
        >
          {shown} {c.counterLabel}
        </div>
      ) : null}
    </>
  );
};

const ClipScene: React.FC<{ c: Extract<SplicedCutaway, { type: "clip" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const t = (frame * 1000) / fps;
  const head = (c.eyebrow ? 90 : 0) + (c.title ? 110 : 0);
  const availH = z.bottom - z.top - head * z.u;
  // The card pushes in 3.5% over the cutaway, so even a thin strip starts at 94% width.
  const maxW = c.crop.width / c.crop.height > 4 ? z.W * 0.94 : z.W * 0.86;
  const s = Math.min(maxW / c.crop.width, (availH * 0.97) / c.crop.height);
  const cardW = c.crop.width * s;
  const cardH = c.crop.height * s;
  const push = interpolate(frame, [0, msToFrame(c.durMs, fps)], [1, 1.035], CLAMP);
  const p = enter(frame, fps);
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        width: z.W,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20 * z.u,
      }}
    >
      {c.eyebrow ? <Chip text={c.eyebrow} theme={theme} /> : null}
      {c.title ? (
        <div
          style={{
            fontFamily: theme.displayFontFamily,
            fontWeight: 900,
            fontSize: 88 * z.u,
            lineHeight: 1,
            color: theme.foreground,
            textTransform: "uppercase",
            textAlign: "center",
          }}
        >
          {c.title}
        </div>
      ) : null}
      <div
        style={{
          position: "relative",
          width: cardW,
          height: cardH,
          overflow: "hidden",
          borderRadius: 26 * z.u,
          border: `${5 * z.u}px solid ${theme.foreground}`,
          boxShadow: `0 ${30 * z.u}px ${90 * z.u}px rgba(0,0,0,0.6)`,
          transform: `scale(${interpolate(p, [0, 1], [0.9, 1]) * push})`,
          opacity: p,
        }}
      >
        <OffthreadVideo
          src={resolveSrc(c.src)}
          trimBefore={c.sourceFrom}
          muted
          style={{
            position: "absolute",
            left: -c.crop.x * s,
            top: -c.crop.y * s,
            width: (c.sourceWidth ?? 1920) * s,
            height: (c.sourceHeight ?? 1080) * s,
          }}
        />
        {(c.rings ?? []).map((ring, i) => {
          const end = ring.atMs + (ring.durMs ?? c.durMs);
          if (t < ring.atMs || t >= end) return null;
          const rp = spring({ frame: frame - msToFrame(ring.atMs, fps), fps, config: { damping: 11, mass: 0.5 } });
          const r = ring.r * s;
          return (
            <React.Fragment key={i}>
              <div
                style={{
                  position: "absolute",
                  left: (ring.x - c.crop.x) * s - r,
                  top: (ring.y - c.crop.y) * s - r,
                  width: r * 2,
                  height: r * 2,
                  borderRadius: r * 2,
                  border: `${7 * z.u}px solid ${theme.accent}`,
                  boxShadow: `0 0 ${30 * z.u}px ${theme.accent}`,
                  transform: `scale(${interpolate(rp, [0, 1], [1.8, 1])})`,
                  opacity: rp,
                }}
              />
              {ring.label ? (
                <div
                  style={{
                    position: "absolute",
                    left:
                      ring.labelAlign === "left"
                        ? (ring.x - c.crop.x) * s - r
                        : ring.labelAlign === "right"
                          ? (ring.x - c.crop.x) * s + r
                          : (ring.x - c.crop.x) * s,
                    top: (ring.y - c.crop.y) * s + r + 12 * z.u,
                    transform: `translateX(${
                      ring.labelAlign === "left" ? "0%" : ring.labelAlign === "right" ? "-100%" : "-50%"
                    }) scale(${rp})`,
                    transformOrigin: ring.labelAlign === "left" ? "0% 0%" : ring.labelAlign === "right" ? "100% 0%" : "50% 0%",
                    backgroundColor: theme.accent,
                    color: theme.foreground,
                    fontFamily: theme.displayFontFamily,
                    fontWeight: 800,
                    fontSize: 34 * z.u,
                    letterSpacing: 2 * z.u,
                    padding: `${6 * z.u}px ${16 * z.u}px`,
                    whiteSpace: "nowrap",
                    textTransform: "uppercase",
                  }}
                >
                  {ring.label}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
        {c.badge ? (
          <div style={{ position: "absolute", right: 18 * z.u, bottom: 18 * z.u }}>
            <Chip text={c.badge} theme={theme} tone="dark" size={26} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** A pull quote: the text sized to fill the zone, then an optional attribution and note. Use only text you have the right to show. */
const QuoteScene: React.FC<{ c: Extract<SplicedCutaway, { type: "quote" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const p = enter(frame, fps, 2);
  // Largest size whose wrapped lines fit what the eyebrow, attribution and note leave of the zone.
  const noteLines = c.note ? Math.ceil(c.note.length / Math.max(1, Math.floor((z.W * 0.86) / (34 * z.u * 0.5)))) : 0;
  const reserved = ((c.eyebrow ? 72 : 0) + (c.attribution ? 56 : 0) + noteLines * 44 + 3 * 22) * z.u;
  const room = Math.max(0, (z.bottom - z.top - reserved) * 0.9);
  let size = 130 * z.u;
  while (size > 40 * z.u) {
    const perLine = Math.max(1, Math.floor((z.W * 0.86) / (size * 0.5)));
    const lines = Math.ceil(c.quote.length / perLine) + (c.quote.length > perLine ? 1 : 0);
    if (lines * size * 0.98 <= room) break;
    size -= 4 * z.u;
  }
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        width: z.W,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22 * z.u,
      }}
    >
      {c.eyebrow ? <Chip text={c.eyebrow} theme={theme} size={34} /> : null}
      <div
        style={{
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 0.98,
          color: theme.foreground,
          textTransform: "uppercase",
          textAlign: "center",
          maxWidth: z.W * 0.86,
          opacity: p,
          transform: `translateY(${(1 - p) * 60 * z.u}px)`,
        }}
      >
        {c.quote}
      </div>
      {c.attribution ? (
        <div
          style={{
            fontFamily: theme.fontFamily,
            fontWeight: 700,
            fontSize: 42 * z.u,
            color: theme.accent,
            textAlign: "center",
            opacity: interpolate(frame, [8, 16], [0, 1], CLAMP),
          }}
        >
          {c.attribution}
        </div>
      ) : null}
      {c.note ? (
        <div
          style={{
            fontFamily: theme.fontFamily,
            fontWeight: 500,
            fontSize: 34 * z.u,
            color: theme.foreground,
            textAlign: "center",
            maxWidth: z.W * 0.86,
            opacity: interpolate(frame, [10, 18], [0, 1], CLAMP),
          }}
        >
          {c.note}
        </div>
      ) : null}
    </div>
  );
};

const StatScene: React.FC<{ c: Extract<SplicedCutaway, { type: "stat" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const p = spring({ frame: frame - 2, fps, config: { damping: 10, mass: 0.6 } });
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        width: z.W,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18 * z.u,
      }}
    >
      {c.eyebrow ? <Chip text={c.eyebrow} theme={theme} tone="light" /> : null}
      <div
        style={{
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 235 * z.u,
          lineHeight: 0.9,
          color: theme.accent,
          textTransform: "uppercase",
          transform: `scale(${interpolate(p, [0, 1], [1.6, 1])}) rotate(${interpolate(p, [0, 1], [-6, -2])}deg)`,
          opacity: interpolate(frame, [0, 3], [0, 1], CLAMP),
          WebkitTextStroke: `${6 * z.u}px ${theme.foreground}`,
          paintOrder: "stroke fill",
        }}
      >
        {c.value}
      </div>
      <div
        style={{
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 150 * z.u,
          lineHeight: 0.9,
          color: theme.foreground,
          textTransform: "uppercase",
          opacity: enter(frame, fps, 5),
        }}
      >
        {c.label}
      </div>
      {c.sublabel ? (
        <div
          style={{
            fontFamily: theme.fontFamily,
            fontWeight: 600,
            fontSize: 60 * z.u,
            color: theme.foreground,
            opacity: interpolate(frame, [12, 20], [0, 0.9], CLAMP),
          }}
        >
          {c.sublabel}
        </div>
      ) : null}
    </div>
  );
};

const CtaScene: React.FC<{ c: Extract<SplicedCutaway, { type: "cta" }>; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = useZone();
  const pulse = 1 + 0.025 * Math.sin(frame / 4);
  return (
    <div
      style={{
        position: "absolute",
        top: z.top,
        height: z.bottom - z.top,
        width: z.W,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 38 * z.u,
      }}
    >
      {c.eyebrow ? <Chip text={c.eyebrow} theme={theme} size={36} /> : null}
      <div
        style={{
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 150 * z.u,
          lineHeight: 0.9,
          color: theme.foreground,
          textTransform: "uppercase",
          textAlign: "center",
          whiteSpace: "pre-line",
          opacity: enter(frame, fps),
          transform: `translateY(${(1 - enter(frame, fps)) * 60 * z.u}px)`,
        }}
      >
        {c.title}
      </div>
      <div
        style={{
          backgroundColor: theme.foreground,
          color: theme.background,
          fontFamily: theme.fontFamily,
          fontWeight: 700,
          fontSize: 54 * z.u,
          padding: `${24 * z.u}px ${34 * z.u}px`,
          transform: `scale(${enter(frame, fps, 6) * pulse})`,
          whiteSpace: "nowrap",
        }}
      >
        {c.url}
      </div>
      {c.button ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20 * z.u,
            backgroundColor: theme.accent,
            color: theme.foreground,
            fontFamily: theme.displayFontFamily,
            fontWeight: 800,
            fontSize: 64 * z.u,
            letterSpacing: 2 * z.u,
            textTransform: "uppercase",
            padding: `${18 * z.u}px ${40 * z.u}px`,
            opacity: enter(frame, fps, 10),
          }}
        >
          {c.button}
          <div
            style={{
              width: 0,
              height: 0,
              borderTop: `${18 * z.u}px solid transparent`,
              borderBottom: `${18 * z.u}px solid transparent`,
              borderLeft: `${28 * z.u}px solid ${theme.foreground}`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
};

const Cutaway: React.FC<{ c: SplicedCutaway; theme: SplicedShortTheme }> = ({ c, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const len = Math.max(1, msToFrame(c.durMs, fps));
  const u = unitOf(W, H);
  const opacity = interpolate(frame, [0, 3, len - 3, len], [0, 1, 1, 0], CLAMP);
  const scale = interpolate(frame, [0, 6], [1.08, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `scale(${scale})`,
        backgroundColor: theme.background,
        backgroundImage: `linear-gradient(${theme.surface} ${2 * u}px, transparent ${2 * u}px), linear-gradient(90deg, ${theme.surface} ${2 * u}px, transparent ${2 * u}px)`,
        backgroundSize: `${90 * u}px ${90 * u}px`,
      }}
    >
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, transparent 30%, ${theme.background} 85%)` }} />
      {c.type === "title" ? <TitleScene c={c} theme={theme} /> : null}
      {c.type === "chat" ? <ChatScene c={c} theme={theme} /> : null}
      {c.type === "checklist" ? <ChecklistScene c={c} theme={theme} /> : null}
      {c.type === "overload" ? <OverloadScene c={c} theme={theme} /> : null}
      {c.type === "clip" ? <ClipScene c={c} theme={theme} /> : null}
      {c.type === "stat" ? <StatScene c={c} theme={theme} /> : null}
      {c.type === "cta" ? <CtaScene c={c} theme={theme} /> : null}
      {c.type === "quote" ? <QuoteScene c={c} theme={theme} /> : null}
    </AbsoluteFill>
  );
};

const Kicker: React.FC<{ k: SplicedKicker; theme: SplicedShortTheme }> = ({ k, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const u = unitOf(W, H);
  const len = msToFrame(k.durMs, fps);
  const p = spring({ frame, fps, config: { damping: 11, mass: 0.5 } });
  const out = interpolate(frame, [len - 4, len], [1, 0], CLAMP);
  return (
    <div
      style={{
        position: "absolute",
        top: k.y ?? H * 0.15,
        width: W,
        display: "flex",
        justifyContent: "center",
        opacity: out,
      }}
    >
      <div
        style={{
          backgroundColor: theme.accent,
          color: theme.foreground,
          fontFamily: theme.displayFontFamily,
          fontWeight: 900,
          fontSize: 92 * u,
          textTransform: "uppercase",
          padding: `${8 * u}px ${30 * u}px`,
          boxShadow: `0 ${14 * u}px ${40 * u}px rgba(0,0,0,0.5)`,
          transform: `scale(${interpolate(p, [0, 1], [2.2, 1])}) rotate(${k.rotate ?? -3}deg)`,
          opacity: p,
        }}
      >
        {k.text}
      </div>
    </div>
  );
};

const NameTag: React.FC<{ tag: NonNullable<SplicedShortProps["nameTag"]>; theme: SplicedShortTheme }> = ({ tag, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const safe = React.useContext(SafeAreaContext);
  const u = unitOf(W, H);
  const len = msToFrame(tag.durMs, fps);
  const p = enter(frame, fps);
  const out = interpolate(frame, [len - 6, len], [0, 1], CLAMP);
  return (
    <div
      style={{
        position: "absolute",
        top: H * (W > H ? 0.105 : safe?.top ?? DEFAULT_BAND.top),
        left: 56 * u,
        display: "flex",
        gap: 18 * u,
        padding: `${14 * u}px ${26 * u}px ${14 * u}px ${14 * u}px`,
        backgroundColor: "rgba(0,0,0,0.62)",
        transform: `translateX(${(1 - p + out) * -680 * u}px)`,
      }}
    >
      <div style={{ width: 12 * u, backgroundColor: theme.accent }} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontFamily: theme.displayFontFamily,
            fontWeight: 800,
            fontSize: 62 * u,
            lineHeight: 1,
            color: theme.foreground,
            textTransform: "uppercase",
            textShadow: `0 ${4 * u}px ${14 * u}px rgba(0,0,0,0.7)`,
          }}
        >
          {tag.name}
        </div>
        {tag.title ? (
          <div
            style={{
              fontFamily: theme.fontFamily,
              fontWeight: 700,
              fontSize: 32 * u,
              letterSpacing: 5 * u,
              color: theme.foreground,
              opacity: 0.85,
              textTransform: "uppercase",
              textShadow: `0 ${3 * u}px ${10 * u}px rgba(0,0,0,0.7)`,
            }}
          >
            {tag.title}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const SplicedShort: React.FC<SplicedShortProps> = (props) => {
  const { fps } = useVideoConfig();
  const theme: SplicedShortTheme = { ...DEFAULT_THEME, ...(props.theme ?? {}) };
  let cursor = 0;
  // A zero-length range would make Remotion's Sequence throw mid-render; skip it instead.
  const placed = (props.segments ?? [])
    .filter((segment) => segmentFrames(segment) > 0)
    .map((segment) => {
      const outFrom = cursor;
      cursor += segmentFrames(segment);
      return { segment, outFrom };
    });
  const whooshAt = [
    ...(props.punchIns ?? []).filter((p) => p.whoosh !== false).map((p) => p.atMs),
    ...(props.cutaways ?? []).filter((c) => c.whoosh !== false).map((c) => c.atMs),
  ];

  return (
    <SafeAreaContext.Provider value={props.safeArea}>
      <AbsoluteFill style={{ backgroundColor: theme.background }}>
        {placed.map(({ segment, outFrom }, i) => (
          <Sequence key={`seg-${i}`} from={outFrom} durationInFrames={segmentFrames(segment)}>
            <FaceShot segment={segment} outFrom={outFrom} props={props} theme={theme} />
          </Sequence>
        ))}
        {(props.kickers ?? []).map((k, i) => (
          <Sequence key={`kick-${i}`} from={msToFrame(k.atMs, fps)} durationInFrames={Math.max(1, msToFrame(k.durMs, fps))}>
            <Kicker k={k} theme={theme} />
          </Sequence>
        ))}
        {(props.cutaways ?? []).map((c, i) => (
          <Sequence key={`cut-${i}`} from={msToFrame(c.atMs, fps)} durationInFrames={Math.max(1, msToFrame(c.durMs, fps))}>
            <Cutaway c={c} theme={theme} />
          </Sequence>
        ))}
        {props.nameTag ? (
          <Sequence from={msToFrame(props.nameTag.atMs, fps)} durationInFrames={Math.max(1, msToFrame(props.nameTag.durMs, fps))}>
            <NameTag tag={props.nameTag} theme={theme} />
          </Sequence>
        ) : null}
        <Captions props={props} theme={theme} />
        {props.whooshSrc
          ? whooshAt.map((atMs, i) => (
              <Sequence key={`whoosh-${i}`} from={Math.max(0, msToFrame(atMs, fps) - 2)} layout="none">
                <Audio src={resolveSrc(props.whooshSrc as string)} volume={props.whooshVolume ?? 0.5} />
              </Sequence>
            ))
          : null}
        {(props.sfx ?? []).map((s, i) => (
          <Sequence key={`sfx-${i}`} from={msToFrame(s.atMs, fps)} layout="none">
            <Audio src={resolveSrc(s.src)} volume={s.volume ?? 0.5} />
          </Sequence>
        ))}
      </AbsoluteFill>
    </SafeAreaContext.Provider>
  );
};
