import React from "react";
import { staticFile } from "remotion";
import { Video } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { TitleCard } from "./TitleCard";
import { DemoLabel } from "./DemoLabel";

const FPS = 30;
const TRANSITION_FRAMES = 15;

const demos = [
  {
    number: 1,
    name: "Manus",
    tagline: "60 sub-agents in parallel → corporate slides, websites, research",
    file: "manus.mp4",
    durationSec: 131,
  },
  {
    number: 2,
    name: "Genspark Call For Me",
    tagline: "97% booking success — agents leaving the screen",
    file: "genspark.mp4",
    durationSec: 62,
  },
  {
    number: 3,
    name: "OpenClaw + Ray-Ban",
    tagline: "Agents on your face — voice + vision + action",
    file: "openclaw.mp4",
    durationSec: 26,
  },
  {
    number: 4,
    name: "Claude Dispatch + Computer Use",
    tagline: "Phone → Mac takeover — the harness GoBot runs on",
    file: "claude-cowork.mp4",
    durationSec: 73,
  },
];

export const DemoReel: React.FC = () => {
  const introFrames = 3 * FPS; // 3 seconds
  const labelFrames = 2 * FPS; // 2 seconds per label
  const outroFrames = 3 * FPS; // 3 seconds

  return (
    <TransitionSeries>
      {/* Intro title card */}
      <TransitionSeries.Sequence durationInFrames={introFrames}>
        <TitleCard
          title="FY27 Agentic Strategy Sync"
          subtitle="Demo Reel — The Agent Harness Era"
          color="#0f172a"
        />
      </TransitionSeries.Sequence>

      {demos.map((demo, i) => (
        <React.Fragment key={demo.name}>
          {/* Transition into label */}
          <TransitionSeries.Transition
            presentation={i % 2 === 0 ? fade() : slide({ direction: "from-right" })}
            timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
          />

          {/* Demo label card */}
          <TransitionSeries.Sequence durationInFrames={labelFrames}>
            <DemoLabel
              number={demo.number}
              name={demo.name}
              tagline={demo.tagline}
              color="#0f172a"
            />
          </TransitionSeries.Sequence>

          {/* Transition into video */}
          <TransitionSeries.Transition
            presentation={fade()}
            timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
          />

          {/* Demo video clip */}
          <TransitionSeries.Sequence durationInFrames={demo.durationSec * FPS}>
            <Video src={staticFile(demo.file)} />
          </TransitionSeries.Sequence>
        </React.Fragment>
      ))}

      {/* Final transition to outro */}
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
      />

      {/* Outro card */}
      <TransitionSeries.Sequence durationInFrames={outroFrames}>
        <TitleCard
          title="The Harness IS the Product"
          subtitle="Straits Interactive — FY27 Strategy"
          color="#0f172a"
        />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
