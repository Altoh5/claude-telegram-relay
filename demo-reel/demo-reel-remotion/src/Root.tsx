import React from "react";
import { Composition } from "remotion";
import { DemoReel } from "./DemoReel";

export const Root: React.FC = () => {
  // Intro: 90f, Labels: 4×60=240f, Clips: (131+62+26+73)×30=8760f, Outro: 90f
  // Minus 9 transitions × 15f = 135f
  // Total: 9180 - 135 = 9045 frames
  const totalDuration = 9045;

  return (
    <>
      <Composition
        id="DemoReel"
        component={DemoReel}
        durationInFrames={totalDuration}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
