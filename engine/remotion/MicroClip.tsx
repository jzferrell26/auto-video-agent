import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  CalculateMetadataFunction,
} from "remotion";
import { SERIF, SANS } from "./fonts";
import { BrandTheme } from "./BrandedShort";

// A social micro clip: a short highlight from real footage, in a branded 9:16 vertical
// frame (logo + hook + footage full-width + large burned-in captions). The short-form
// sibling of LessonVideo, sized for Reels / TikTok / Shorts.

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

export interface MicroClipProps {
  theme?: Partial<BrandTheme>;
  logo?: string;
  hook?: string; // short eyebrow/hook at the top
  videoSrc: string;
  captions: WordCaption[];
  clipSeconds: number;
  wordsPerPage?: number;
  width?: number;
  height?: number;
}

const FPS = 30;

export const calculateMicroMetadata: CalculateMetadataFunction<MicroClipProps> = ({ props }) => ({
  durationInFrames: Math.ceil(((props.clipSeconds || 0) + 0.1) * FPS),
  width: props.width || 1080,
  height: props.height || 1920,
});

const resolveSrc = (src: string): string => {
  if (/^(https?:|data:|file:)/.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) return src;
  return staticFile(src);
};

const buildPages = (words: WordCaption[], per: number) => {
  const pages: { words: WordCaption[]; startMs: number; endMs: number }[] = [];
  for (let i = 0; i < words.length; i += per) {
    const slice = words.slice(i, i + per);
    if (!slice.length) continue;
    pages.push({ words: slice, startMs: slice[0].startMs, endMs: slice[slice.length - 1].endMs });
  }
  return pages;
};

const Glow: React.FC<{ base: string; glow: string }> = ({ base, glow }) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 95) * 8;
  const y = 40 + Math.cos(frame / 120) * 6;
  return (
    <AbsoluteFill
      style={{ background: `radial-gradient(60% 40% at ${x}% ${y}%, ${glow}3a 0%, transparent 70%), ${base}` }}
    />
  );
};

const CaptionBlock: React.FC<{ page: { words: WordCaption[]; startMs: number }; theme: BrandTheme }> = ({
  page,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = page.startMs + (frame / fps) * 1000;
  const enter = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  return (
    <div
      style={{
        opacity: enter,
        textAlign: "center",
        fontFamily: SANS,
        fontSize: 68,
        fontWeight: 700,
        lineHeight: 1.28,
      }}
    >
      {page.words.map((w, i) => {
        const active = w.startMs <= nowMs && w.endMs > nowMs;
        const spoken = w.endMs <= nowMs;
        return (
          <span key={i} style={{ color: active ? theme.gold : spoken ? theme.cream : `${theme.cream}77` }}>
            {w.word}
            {i < page.words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};

export const MicroClip: React.FC<MicroClipProps> = (props) => {
  const t: BrandTheme = { ...DEFAULT_THEME, ...(props.theme || {}) };
  const { fps, width } = useVideoConfig();
  const pages = buildPages([...(props.captions || [])].sort((a, b) => a.startMs - b.startMs), props.wordsPerPage ?? 3);

  // Footage full-width (with side margin), letterboxed inside the vertical frame.
  const videoW = width - 80;
  const videoH = Math.round((videoW * 9) / 16);

  return (
    <AbsoluteFill style={{ backgroundColor: t.slate }}>
      <Glow base={t.slate} glow={t.teal} />

      {/* Header: logo + hook */}
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 130 }}>
        {props.logo && <Img src={props.logo} style={{ width: 90, height: 90, objectFit: "contain" }} />}
        {props.hook && (
          <div
            style={{
              marginTop: 28,
              maxWidth: 820,
              textAlign: "center",
              fontFamily: SERIF,
              fontSize: 52,
              fontWeight: 500,
              lineHeight: 1.15,
              color: t.cream,
              padding: "0 60px",
            }}
          >
            {props.hook}
          </div>
        )}
      </AbsoluteFill>

      {/* Footage, upper-middle */}
      <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: 430 }}>
        <div
          style={{
            width: videoW,
            height: videoH,
            borderRadius: 20,
            overflow: "hidden",
            border: `2px solid ${themeBorder(t)}`,
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          }}
        >
          <OffthreadVideo src={resolveSrc(props.videoSrc)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </AbsoluteFill>

      {/* Captions in the lower third */}
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const nextStart = pages[i + 1]?.startMs ?? page.endMs + 500;
        const dur = Math.max(1, Math.round(((nextStart - page.startMs) / 1000) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", padding: "1130px 70px 0" }}>
              <CaptionBlock page={page} theme={t} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

function themeBorder(t: BrandTheme): string {
  return `${t.gold}55`;
}
