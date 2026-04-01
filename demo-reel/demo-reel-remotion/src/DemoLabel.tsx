import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

export const DemoLabel: React.FC<{
  number: number;
  name: string;
  tagline: string;
  color?: string;
}> = ({ number, name, tagline, color = "#0f172a" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const numberOpacity = interpolate(frame, [0, 0.3 * fps], [0, 0.15], {
    extrapolateRight: "clamp",
  });
  const numberScale = interpolate(frame, [0, 0.4 * fps], [0.8, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const textOpacity = interpolate(frame, [0.15 * fps, 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const textX = interpolate(frame, [0.15 * fps, 0.5 * fps], [-40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const taglineOpacity = interpolate(frame, [0.4 * fps, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          opacity: numberOpacity,
          transform: `scale(${numberScale})`,
          fontSize: 300,
          fontWeight: 900,
          color: "white",
          position: "absolute",
          fontFamily: "SF Pro Display, -apple-system, Helvetica Neue, sans-serif",
        }}
      >
        {number}
      </div>
      <div style={{ zIndex: 1, textAlign: "center" }}>
        <div
          style={{
            opacity: textOpacity,
            transform: `translateX(${textX}px)`,
            color: "white",
            fontSize: 56,
            fontWeight: 700,
            fontFamily: "SF Pro Display, -apple-system, Helvetica Neue, sans-serif",
            letterSpacing: -1,
          }}
        >
          {name}
        </div>
        <div
          style={{
            opacity: taglineOpacity,
            color: "#94a3b8",
            fontSize: 24,
            fontWeight: 400,
            fontFamily: "SF Pro Display, -apple-system, Helvetica Neue, sans-serif",
            marginTop: 12,
          }}
        >
          {tagline}
        </div>
      </div>
    </AbsoluteFill>
  );
};
