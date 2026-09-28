import type { Branding } from "../shared/branding";
import { escapeHtml } from "./security";

export function brandIcons(branding: Branding): string {
  const favicon = branding.assets.favicon;
  const apple = branding.assets.appleTouch;
  return `${favicon ? `<link rel="icon" type="image/png" sizes="32x32" href="${escapeHtml(favicon.path)}">` : ""}${apple ? `<link rel="apple-touch-icon" type="image/png" sizes="180x180" href="${escapeHtml(apple.path)}">` : ""}`;
}
export function brandOpenGraph(
  branding: Branding,
  origin: string,
  name: string,
): string {
  const asset = branding.assets.ogImage;
  if (!asset) return "";
  return `<meta property="og:image" content="${escapeHtml(origin + asset.path)}"><meta property="og:image:secure_url" content="${escapeHtml(origin + asset.path)}"><meta property="og:image:type" content="${asset.mime}"><meta property="og:image:width" content="${asset.width}"><meta property="og:image:height" content="${asset.height}"><meta property="og:image:alt" content="${escapeHtml(name)}">`;
}
export function inertJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
