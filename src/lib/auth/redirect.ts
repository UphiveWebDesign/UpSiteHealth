/** Allows only same-origin relative paths, preventing open redirects. */
export function safeRedirectPath(
  value: unknown,
  fallback = "/dashboard",
): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  return value;
}
