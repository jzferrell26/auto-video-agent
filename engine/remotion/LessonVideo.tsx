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

// A course lesson: branded intro title card -> real teaching footage with burned-in
// word-level captions -> branded outro. This is the "edit existing footage -> course" output.

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

export type LessonVideoProps = {
  theme?: Partial<BrandTheme>;
  logo?: string;
  moduleTitle: string;
  lessonNumber: number;
  lessonTitle: string;
  videoSrc: string; // staticFile-relative or absolute/URL
  captions: WordCaption[];
  clipSeconds: number;
  introSeconds?: number;
  outroSeconds?: number;
  outroEyebrow?: string;
  outroTitle?: string;
  wordsPerPage?: number;
  width?: number;
  height?: number;
};

const FPS = 30;

export const calculateLessonMetadata: CalculateMetadataFunction<LessonVideoProps> = ({ props }) => {
  const intro = props.introSeconds ?? 3;
  const outro = props.outroSeconds ?? 2.6;
  const total = intro + (props.clipSeconds || 0) + outro;
  return {
    durationInFrames: Math.ceil((total + 0.1) * FPS),
    width: props.width || 1920,
    height: props.height || 1080,
  };
};

const resolveSrc = (src: string): string => {
  if (/^(https?:|data:|file:)/.test(src) || /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/")) return src;
  return staticFile(src);
};

const GoldRule: React.FC<{ color: string; delay?: number; width?: number }> = ({ color, delay = 6, width = 150 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 60 } });
  return <div style={{ height: 2, width: interpolate(s, [0, 1], [0, width]), background: color, margin: "0 auto", borderRadius: 2 }} />;
};

const Card: React.FC<{
  theme: BrandTheme;
  logo?: string;
  eyebrow: string;
  title: string;
  seconds: number;
}> = ({ theme, logo, eyebrow, title, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inS = spring({ frame, fps, config: { damping: 200, stiffness: 90 } });
  const out = interpolate(frame, [seconds * fps - 10, seconds * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: theme.slate, opacity: out }}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", padding: "0 160px", gap: 34 }}>
        {logo && <Img src={logo} style={{ width: 108, height: 108, objectFit: "contain", opacity: inS }} />}
        <div style={{ opacity: inS, fontFamily: SANS, fontSize: 30, fontWeight: 500, letterSpacing: "0.32em", textTransform: "uppercase", color: theme.gold }}>
          {eyebrow}
        </div>
        <div
          style={{
            opacity: inS,
            transform: `translateY(${interpolate(inS, [0, 1], [24, 0])}px)`,
            fontFamily: SERIF,
            fontSize: 88,
            fontWeight: 500,
            lineHeight: 1.14,
            color: theme.cream,
            maxWidth: 1300,
          }}
        >
          {title}
        </div>
        <GoldRule color={theme.gold} delay={12} width={150} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
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

const CaptionPill: React.FC<{ page: { words: WordCaption[]; startMs: number }; theme: BrandTheme }> = ({ page, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = page.startMs + (frame / fps) * 1000;
  const enter = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 90 }}>
      <div
        style={{
          opacity: enter,
          maxWidth: "78%",
          textAlign: "center",
          background: "rgba(35, 45, 43, 0.72)",
          borderRadius: 14,
          padding: "16px 32px",
          fontFamily: SANS,
          fontSize: 46,
          fontWeight: 600,
          lineHeight: 1.3,
        }}
      >
        {page.words.map((w, i) => {
          const active = w.startMs <= nowMs && w.endMs > nowMs;
          const spoken = w.endMs <= nowMs;
          return (
            <span key={i} style={{ color: active ? theme.gold : spoken ? theme.cream : `${theme.cream}88` }}>
              {w.word}
              {i < page.words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Captions: React.FC<{ words: WordCaption[]; theme: BrandTheme; wordsPerPage: number }> = ({ words, theme, wordsPerPage }) => {
  const { fps } = useVideoConfig();
  const pages = buildPages([...words].sort((a, b) => a.startMs - b.startMs), wordsPerPage);
  return (
    <AbsoluteFill>
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const nextStart = pages[i + 1]?.startMs ?? page.endMs + 500;
        const dur = Math.max(1, Math.round(((nextStart - page.startMs) / 1000) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <CaptionPill page={page} theme={theme} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const LessonVideo: React.FC<LessonVideoProps> = (props) => {
  const t: BrandTheme = { ...DEFAULT_THEME, ...(props.theme || {}) };
  const intro = props.introSeconds ?? 3;
  const outro = props.outroSeconds ?? 2.6;
  const clip = props.clipSeconds;
  const introF = Math.round(intro * FPS);
  const clipF = Math.round(clip * FPS);
  const outroF = Math.round(outro * FPS);

  return (
    <AbsoluteFill style={{ backgroundColor: t.slate }}>
      <Sequence from={0} durationInFrames={introF}>
        <Card
          theme={t}
          logo={props.logo}
          eyebrow={`${props.moduleTitle}  ·  Lesson ${props.lessonNumber}`}
          title={props.lessonTitle}
          seconds={intro}
        />
      </Sequence>

      <Sequence from={introF} durationInFrames={clipF}>
        <AbsoluteFill>
          <OffthreadVideo src={resolveSrc(props.videoSrc)} />
          <Captions words={props.captions} theme={t} wordsPerPage={props.wordsPerPage ?? 4} />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={introF + clipF} durationInFrames={outroF}>
        <Card
          theme={t}
          logo={props.logo}
          eyebrow={props.outroEyebrow ?? ""}
          title={props.outroTitle ?? ""}
          seconds={outro}
        />
      </Sequence>
    </AbsoluteFill>
  );
};
