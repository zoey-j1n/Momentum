// The logo: public/logo.png (the same file is app/icon.png, which Next serves as the favicon).
// A 1024px square with its own dark background, so it is shown as a rounded tile.
import Image from "next/image";

export function MomentumMark({ size = 36 }: { size?: number }) {
  return <Image src="/logo.png" alt="" width={size} height={size} priority style={{ borderRadius: Math.round(size * 0.22), display: "block" }} />;
}
