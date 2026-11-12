import { Composition } from "remotion";
import { BrandedShort, calculateBrandedShortMetadata, type BrandedShortProps } from "../engine/remotion/BrandedShort";
import { CaptionedShort, calculateCaptionedMetadata } from "../engine/remotion/CaptionedShort";
import { CourseCover } from "../engine/remotion/CourseCover";
import { LessonVideo, calculateLessonMetadata } from "../engine/remotion/LessonVideo";
import { MicroClip, calculateMicroMetadata } from "../engine/remotion/MicroClip";
import { SplicedShort, calculateSplicedShortMetadata, type SplicedShortProps } from "../engine/remotion/SplicedShort";

const short: BrandedShortProps = {
  width: 1920,
  height: 1080,
  scenes: [
    { type: "intro", eyebrow: "YOUR FIRST VIDEO", headline: "Make something worth sharing.", seconds: 3 },
    { type: "outro", quote: "Your story. Your style.", signoff: "Built with Auto Video Agent", seconds: 3 },
  ],
};

// Synthetic timings, not a transcript from a real recording.
const captions = [
  { word: "Synthetic", startMs: 0, endMs: 1000 },
  { word: "demo", startMs: 1000, endMs: 2000 },
  { word: "captions", startMs: 2000, endMs: 3000 },
];

// Synthetic splice: two 3-second ranges of the demo clip, one cutaway of each kind that
// needs no media. No whoosh file is set, so this default preview is silent apart from the tone.
const spliced: SplicedShortProps = {
  segments: [
    { src: "demo/source.mp4", fromFrame: 0, toFrame: 90, centerX: 0.5 },
    { src: "demo/source.mp4", fromFrame: 90, toFrame: 180, centerX: 0.5, zoom: 1.12 },
  ],
  sourceWidth: 1280,
  sourceHeight: 720,
  drift: 0.03,
  punchIns: [{ atMs: 1200, durMs: 800, scale: 1.25, ramp: "ease", anchorY: 0.4 }],
  captions,
  cutaways: [
    { type: "title", atMs: 3000, durMs: 1200, eyebrow: "SYNTHETIC DEMO", title: "Splice\nyour takes", subtitle: "Placeholder copy" },
    { type: "stat", atMs: 4400, durMs: 1200, eyebrow: "EXAMPLE", value: "42", label: "Example stat", sublabel: "Placeholder number" },
  ],
  kickers: [{ atMs: 300, durMs: 900, text: "Sample" }],
};

export const Root = () => (
  <>
    <Composition id="BrandedShort" component={BrandedShort} fps={30} width={1920} height={1080}
      durationInFrames={192} defaultProps={short} calculateMetadata={calculateBrandedShortMetadata} />
    <Composition id="CourseCover" component={CourseCover} fps={30} width={1920} height={1080}
      durationInFrames={90} defaultProps={{ title: "Your first course", eyebrow: "STUDENT DEMO", subtitle: "Start with one useful lesson." }} />
    <Composition id="LessonVideo" component={LessonVideo} fps={30} width={1920} height={1080}
      durationInFrames={354} calculateMetadata={calculateLessonMetadata}
      defaultProps={{ moduleTitle: "Demo module", lessonNumber: 1, lessonTitle: "Your first lesson", videoSrc: "demo/source.mp4", clipSeconds: 6, captions }} />
    <Composition id="MicroClip" component={MicroClip} fps={30} width={1080} height={1920}
      durationInFrames={183} calculateMetadata={calculateMicroMetadata}
      defaultProps={{ hook: "A useful idea", videoSrc: "demo/source.mp4", clipSeconds: 6, captions }} />
    <Composition id="CaptionedShort" component={CaptionedShort} fps={30} width={1080} height={1920}
      durationInFrames={114} calculateMetadata={calculateCaptionedMetadata}
      defaultProps={{ eyebrow: "SYNTHETIC DEMO", audio: "demo/audio.wav", captions }} />
    <Composition id="SplicedShort" component={SplicedShort} fps={30} width={1080} height={1920}
      durationInFrames={180} calculateMetadata={calculateSplicedShortMetadata} defaultProps={spliced} />
  </>
);
