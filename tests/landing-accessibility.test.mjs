import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const css = readFileSync(
  new URL("../src/landing.css", import.meta.url),
  "utf8",
);
function luminance(hex) {
  const values = hex
    .slice(1)
    .match(/../g)
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
test("cover text and every primary button gradient stop meet AA contrast in both themes and hover", () => {
  for (const selector of [".cover-continue", ".cover-continue:hover"]) {
    const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const stops = block
      .match(/background: linear-gradient\(([^;]+)\);/)[1]
      .match(/#[a-f0-9]{6}/gi);
    assert.equal(stops.length, 2);
    for (const color of stops)
      assert.ok(
        contrast("#ffffff", color) >= 4.5,
        `${selector} contrast at ${color}`,
      );
  }
  const paper = css.match(
    /--cover-paper: light-dark\((#[a-f0-9]{6}), (#[a-f0-9]{6})\)/i,
  );
  const muted = css.match(
    /--cover-muted: light-dark\((#[a-f0-9]{6}), (#[a-f0-9]{6})\)/i,
  );
  for (const theme of [1, 2])
    assert.ok(contrast(paper[theme], muted[theme]) >= 4.5);
});
test("reduced motion disables cover animation, tilt and interaction transitions; entrance motion is finite", () => {
  const reduced = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(reduced, /\.landing-page \*/);
  assert.match(reduced, /animation: none/);
  assert.match(reduced, /transition: none/);
  assert.match(reduced, /\.landing-page \.cover-book/);
  assert.match(reduced, /\.landing-page \.cover-continue/);
  assert.match(reduced, /transform: none/);
  assert.doesNotMatch(css, /\binfinite\b/);
});
