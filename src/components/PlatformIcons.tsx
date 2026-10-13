import { Apple, SquareTerminal } from "lucide-react";
import type { PlatformKey } from "../lib/downloads";

/** Windows logosu (dört pencere); lucide'da marka simgesi olmadığı için satır içi. */
function WindowsIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 5.5 10.5 4.4v7.1H3V5.5Zm8.5-1.25L21 3v8.5h-9.5V4.25ZM3 12.5h7.5v7.1L3 18.5v-6Zm8.5 0H21V21l-9.5-1.25V12.5Z" />
    </svg>
  );
}

export function PlatformIcon({ platform, size = 22 }: { platform: PlatformKey; size?: number }) {
  if (platform === "macos") return <Apple size={size} aria-hidden />;
  if (platform === "windows") return <WindowsIcon size={size} />;
  return <SquareTerminal size={size} aria-hidden />;
}
