import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/** App icon: "TX" on the terminal's accent blue. */
export default function Icon() {
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
          fontSize: 230,
          fontWeight: 800,
          letterSpacing: -8,
        }}
      >
        TX
      </div>
    ),
    size,
  );
}
