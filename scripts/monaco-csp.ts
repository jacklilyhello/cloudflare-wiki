import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const sources = new Map([
  [
    "/monaco-editor/esm/vs/base/browser/domStylesheets.js",
    "d75d479eba46e53fe9c230958a9fdafc871218d6879c79f95ba4a2a5aed760c5",
  ],
  [
    "/monaco-editor/esm/vs/base/browser/ui/contextview/contextview.js",
    "02fa681986193a16bf184f511bfb8528f135b9d2c73877ce18b8deb45ac2ae38",
  ],
]);

// Monaco 0.56 has no public style-nonce hook. This narrowly adapts its two
// style-element constructors, without intercepting document APIs or HTML.
// Upgrades must explicitly review and update the source fingerprints.
export function adaptMonacoStyles(code: string, id: string) {
  if (
    id.endsWith("/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js")
  ) {
    // Monaco vendors an older sanitizer independently of its npm dependency.
    // Use our audited version with an isolated hook/configuration instance.
    if (
      createHash("sha256").update(code).digest("hex") !==
      "380497577cba9a223f307b4ffaba1c105178673acb6ac7e9a64e681934dc6b50"
    )
      throw new Error(
        "Monaco sanitizer source changed; review its dependency adapter before building.",
      );
    return 'import createDOMPurify from "dompurify"; export default createDOMPurify(window);';
  }
  const entry = [...sources].find(([suffix]) => id.endsWith(suffix));
  if (!entry) return null;
  const needle = "const style = document.createElement('style');";
  if (
    createHash("sha256").update(code).digest("hex") !== entry[1] ||
    code.split(needle).length !== 2
  )
    throw new Error(
      "Monaco style source changed; review its CSP adapter before building.",
    );
  return code.replace(
    needle,
    `${needle}
    const wikiStyleNonce = document.querySelector('meta[property="csp-nonce"]')?.nonce;
    if (!wikiStyleNonce || !/^[A-Za-z0-9+/]{24}$/.test(wikiStyleNonce)) {
        throw new Error('Editor style nonce is unavailable. Reload this editor document.');
    }
    style.nonce = wikiStyleNonce;`,
  );
}

export function monacoCsp(): Plugin {
  return {
    name: "wiki-monaco-style-nonce",
    enforce: "pre",
    transform(code, id) {
      const result = adaptMonacoStyles(code, id);
      return result === null ? null : { code: result, map: null };
    },
  };
}
