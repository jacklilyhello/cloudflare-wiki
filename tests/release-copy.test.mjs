import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("product UI omits development status labels while retaining technical workflow names", () => {
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        assert.doesNotMatch(
          source,
          /测试工作空间|测试环境|测试站|Test workspace|Test environment|Test site/i,
          path,
        );
      }
    }
  }
  scan(new URL("../src", import.meta.url).pathname);
  assert.match(
    readFileSync(
      new URL("../src/admin/SettingsPage.tsx", import.meta.url),
      "utf8",
    ),
    /Deploy Production/,
  );
});
