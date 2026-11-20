/**
 * Current platform, read from the client hint and the user agent first:
 * `navigator.platform` is deprecated and lies under user-agent reduction.
 */
export const getPlatform = (): "macos" | "windows" | "linux" => {
  const hint = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const haystack = `${hint ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();

  if (haystack.includes("mac") || haystack.includes("iphone")) return "macos";
  if (haystack.includes("win")) return "windows";
  if (haystack.includes("linux") || haystack.includes("x11")) return "linux";

  const legacy = (navigator.platform ?? "").toLowerCase();
  if (legacy.includes("mac")) return "macos";
  if (legacy.includes("win")) return "windows";
  return "linux";
};

/**
 * Check if current platform is macOS
 */
export const isMacOS = (): boolean => getPlatform() === "macos";

/**
 * Check if current platform is Windows
 */
export const isWindows = (): boolean => getPlatform() === "windows";
