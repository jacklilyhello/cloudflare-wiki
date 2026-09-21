import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { adaptMonacoStyles } from "../scripts/monaco-csp.ts";

const require = createRequire(import.meta.url);
for (const path of [
  "base/browser/domStylesheets",
  "base/browser/ui/contextview/contextview",
]) {
  test(`adapts only the reviewed Monaco style constructor: ${path}`, async () => {
    const id = require.resolve(`monaco-editor/${path}`);
    const source = await readFile(id, "utf8");
    const transformed = adaptMonacoStyles(source, id);
    assert.ok(transformed.includes("style.nonce = wikiStyleNonce"));
    assert.ok(transformed.includes("Editor style nonce is unavailable"));
    assert.equal(transformed.split("style.nonce = wikiStyleNonce").length, 2);
    assert.throws(() => adaptMonacoStyles(`${source}\n`, id), /source changed/);
    assert.throws(() => adaptMonacoStyles(transformed, id), /source changed/);
  });
}

test("never rewrites other modules or intercepts global DOM constructors", () => {
  const source = "const style = document.createElement('style');";
  assert.equal(adaptMonacoStyles(source, "/src/example.js"), null);
  assert.equal(adaptMonacoStyles(source, "/other/domStylesheets.js"), null);
});

test("replaces the embedded old sanitizer with a separate audited DOMPurify instance", async () => {
  const id = require.resolve("monaco-editor/base/browser/dompurify/dompurify");
  const source = await readFile(id, "utf8");
  assert.match(source, /3\.4\.8/);
  const adapted = adaptMonacoStyles(source, id);
  assert.equal(
    adapted,
    'import createDOMPurify from "dompurify"; export default createDOMPurify(window);',
  );
  assert.throws(
    () => adaptMonacoStyles(`${source}\n`, id),
    /sanitizer source changed/,
  );
});
