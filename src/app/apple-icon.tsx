import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home Screen icon for iPad / iPhone. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#2962ff",
          color: "#fff",
          fontSize: 82,
          fontWeight: 800,
          letterSpacing: -3,
        }}
      >
        TX
      </div>
    ),
    size,
  );
}
