import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  CalculateMetadataFunction,
} from "remotion";
import { SANS } from "./fonts";
import { BrandTheme } from "./BrandedShort";

// Caption-first branded proof: VO + burned-in word-level captions in brand style.
// Caption-first: bring your own voiceover audio; faster-whisper timings -> burned-in captions.

export interface WordCaption {
  word: string;
  startMs: number;
  endMs: number;
}

const DEFAULT_THEME: BrandTheme = {
  cream: "#f4f4f5",
  slate: "#18181b",
  teal: "#3f6f6a",
  gold: "#c2a45f",
  sage: "#8a8a94",
};

export interface CaptionedShortProps {
  theme?: Partial<BrandTheme>;
  logo?: string;
  eyebrow?: string;
  audio: string; // staticFile-relative path under public/, or absolute/URL
  captions: WordCaption[];
  wordsPerPage?: number;
  width?: number;
  height?: number;
}

const FPS = 30;

export const calculateCaptionedMetadata: CalculateMetadataFunction<
  CaptionedShortProps
> = ({ props }) => {
  const words = props.captions || [];
  const lastMs = words.length ? words[words.length - 1].endMs : 1000;
  return {
    durationInFrames: Math.ceil((lastMs / 1000 + 0.8) * FPS),
    width: props.width || 1080,
    height: props.height || 1920,
  };
};

interface Page {
  words: WordCaption[];
  startMs: number;
  endMs: number;
}

const buildPages = (words: WordCaption[], per: number): Page[] => {
  const pages: Page[] = [];
  for (let i = 0; i < words.length; i += per) {
    const slice = words.slice(i, i + per);
    if (!slice.length) continue;
    pages.push({ words: slice, startMs: slice[0].startMs, endMs: slice[slice.length - 1].endMs });
  }
  return pages;
};

const resolveSrc = (src: string): string => {
  if (/^(https?:|data:|file:)/.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) {
    return src;
  }
  return staticFile(src);
};

const CaptionPage: React.FC<{ page: Page; theme: BrandTheme }> = ({ page, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = page.startMs + (frame / fps) * 1000;
  const entrance = spring({ frame, fps, config: { damping: 200, stiffness: 110 } });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 120px" }}>
      <div
        style={{
          opacity: entrance,
          transform: `translateY(${interpolate(entrance, [0, 1], [18, 0])}px)`,
          textAlign: "center",
          fontFamily: SANS,
          fontSize: 70,
          fontWeight: 500,
          lineHeight: 1.32,
        }}
      >
        {page.words.map((w, i) => {
          const active = w.startMs <= nowMs && w.endMs > nowMs;
          const spoken = w.endMs <= nowMs;
          return (
            <span
              key={i}
              style={{
                color: active ? theme.gold : spoken ? theme.cream : `${theme.cream}66`,
                textShadow: active ? `0 0 26px ${theme.gold}55` : "none",
              }}
            >
              {w.word}
              {i < page.words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Glow: React.FC<{ base: string; glow: string }> = ({ base, glow }) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 95) * 10;
  const y = 46 + Math.cos(frame / 120) * 8;
  return (
    <AbsoluteFill
      style={{ background: `radial-gradient(58% 42% at ${x}% ${y}%, ${glow}44 0%, transparent 70%), ${base}` }}
    />
  );
};

export const CaptionedShort: React.FC<CaptionedShortProps> = ({
  theme,
  logo,
  eyebrow,
  audio,
  captions,
  wordsPerPage = 4,
}) => {
  const t: BrandTheme = { ...DEFAULT_THEME, ...(theme || {}) };
  const { fps } = useVideoConfig();
  // Sort defensively: word timings from ASR are usually monotonic but not guaranteed.
  const pages = buildPages([...(captions || [])].sort((a, b) => a.startMs - b.startMs), wordsPerPage);

  return (
    <AbsoluteFill style={{ backgroundColor: t.slate }}>
      <Glow base={t.slate} glow={t.teal} />

      {/* Header: logo + eyebrow */}
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 150, pointerEvents: "none" }}>
        {logo && <Img src={logo} style={{ width: 96, height: 96, objectFit: "contain", opacity: 0.95 }} />}
        {eyebrow && (
          <div
            style={{
              marginTop: 26,
              fontFamily: SANS,
              fontSize: 28,
              fontWeight: 500,
              letterSpacing: "0.34em",
              textTransform: "uppercase",
              color: t.gold,
            }}
          >
            {eyebrow}
          </div>
        )}
      </AbsoluteFill>

      {/* Word-level captions, centered */}
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const nextStart = pages[i + 1]?.startMs ?? page.endMs + 600;
        const dur = Math.max(1, Math.round(((nextStart - page.startMs) / 1000) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <CaptionPage page={page} theme={t} />
          </Sequence>
        );
      })}

      {audio && <Audio src={resolveSrc(audio)} />}
    </AbsoluteFill>
  );
};
