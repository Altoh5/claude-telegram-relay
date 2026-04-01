import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

export const TitleCard: React.FC<{
  title: string;
  subtitle?: string;
  color?: string;
}> = ({ title, subtitle, color = "#1a1a2e" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [0, 0.5 * fps], [30, 0], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const subtitleOpacity = interpolate(frame, [0.3 * fps, 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lineWidth = interpolate(frame, [0.2 * fps, 0.7 * fps], [0, 200], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
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
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          color: "white",
          fontSize: 64,
          fontFamily: "SF Pro Display, -apple-system, Helvetica Neue, sans-serif",
          fontWeight: 700,
          textAlign: "center",
          lineHeight: 1.2,
          maxWidth: "80%",
        }}
      >
        {title}
      </div>
      <div
        style={{
          width: lineWidth,
          height: 3,
          backgroundColor: "#6366f1",
          marginTop: 20,
          marginBottom: 20,
          borderRadius: 2,
        }}
      />
      {subtitle && (
        <div
          style={{
            opacity: subtitleOpacity,
            color: "#a0a0c0",
            fontSize: 28,
            fontFamily: "SF Pro Display, -apple-system, Helvetica Neue, sans-serif",
            fontWeight: 400,
            textAlign: "center",
            maxWidth: "70%",
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
