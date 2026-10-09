import { posix, win32 } from "node:path";
export function hostPaths(host, platform = process.platform) {
  return host === "remote" || platform !== "win32" ? posix : win32;
}
export function hostOS(host, platform = process.platform) {
  return host === "remote"
    ? "Linux"
    : ({ win32: "Windows", darwin: "macOS", linux: "Linux" }[platform] ??
        platform);
}
export function normalizeHostPath(value, host, platform = process.platform) {
  const paths = hostPaths(host, platform);
  const normalized = paths.normalize(value).replace(/[\\/]$/, "");
  return paths === win32 ? normalized.toLowerCase() : normalized;
}
