import { Composition } from "remotion";
import { BrandedShort, calculateBrandedShortMetadata, type BrandedShortProps } from "../engine/remotion/BrandedShort";
import { CaptionedShort, calculateCaptionedMetadata } from "../engine/remotion/CaptionedShort";
import { CourseCover } from "../engine/remotion/CourseCover";
import { LessonVideo, calculateLessonMetadata } from "../engine/remotion/LessonVideo";
import { MicroClip, calculateMicroMetadata } from "../engine/remotion/MicroClip";

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
  </>
);
