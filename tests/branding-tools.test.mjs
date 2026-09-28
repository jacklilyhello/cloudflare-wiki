import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { captureBranding } from "../scripts/backup-branding.mjs";
import {
  BRAND_VARIABLES,
  checkVariableLimits,
  decodeBranding,
  encodeBranding,
  inspectBrandImage,
  MANIFEST_VARIABLE,
} from "../scripts/branding-config.mjs";
import {
  buildBranding,
  readBuiltBranding,
} from "../scripts/build-branding.mjs";
import { buildDeploymentConfig } from "../scripts/deploy-policy.mjs";
import { installBranding } from "../scripts/install-branding.mjs";
import { prepareBranding } from "../scripts/prepare-branding.mjs";
import {
  BRAND_ROLES,
  parseBranding,
  publicOrigin,
} from "../shared/branding.ts";

async function image(width, height, format = "png") {
  return sharp({
    create: { width, height, channels: 4, background: "#285ad4" },
  })
    .toFormat(format)
    .toBuffer();
}
async function fixture() {
  const images = {
    logoLight: await image(120, 48),
    logoDark: await image(120, 48, "webp"),
    favicon: await image(32, 32),
    appleTouch: await image(180, 180),
    ogImage: await image(1200, 630, "jpeg"),
  };
  const variables = await encodeBranding(
    {
      assets: Object.fromEntries(BRAND_ROLES.map((role) => [role, role])),
      locales: {
        zh: {
          footer: "中文页脚 <script>不可执行</script>",
          copyright: "版权测试",
        },
        en: {
          name: "Fixture wiki",
          footer: "English footer",
          copyright: "Copyright fixture",
        },
      },
    },
    async (role) => images[role],
  );
  return { images, variables };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "wiki-branding-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("five role images round-trip with exact hashes, bytes, dimensions and bilingual text", async () => {
  const { images, variables } = await fixture();
  const decoded = await decodeBranding(variables);
  assert.equal(decoded.files.length, 5);
  for (const role of BRAND_ROLES) {
    const item = decoded.files.find((file) =>
      file.asset.path.includes(`/${role}-`),
    );
    assert.deepEqual(item.bytes, images[role]);
    assert.equal(item.asset.bytes, images[role].length);
  }
  assert.equal(
    decoded.branding.locales.zh.footer,
    "中文页脚 <script>不可执行</script>",
  );
  assert.equal((await decodeBranding({})).files.length, 0);
  assert.equal(
    (await decodeBranding({ [MANIFEST_VARIABLE]: "{}" })).files.length,
    0,
  );
});
test("invalid images, wrong icon dimensions, SVG, corrupt bytes and inconsistent manifests fail", async () => {
  for (const [role, bytes] of [
    ["favicon", await image(31, 32)],
    ["appleTouch", await image(180, 180, "jpeg")],
    ["ogImage", await image(1200, 630, "webp")],
    ["logoLight", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["logoLight", (await image(80, 40)).subarray(0, 40)],
  ])
    await assert.rejects(inspectBrandImage(role, bytes));
  const still = await image(80, 40);
  const animationChunk = Buffer.alloc(20);
  animationChunk.writeUInt32BE(8);
  animationChunk.write("acTL", 4, "ascii");
  animationChunk.writeUInt32BE(2, 8);
  await assert.rejects(
    inspectBrandImage(
      "logoLight",
      Buffer.concat([
        still.subarray(0, 33),
        animationChunk,
        still.subarray(33),
      ]),
    ),
  );
  await assert.rejects(
    inspectBrandImage(
      "logoLight",
      Buffer.concat([still, Buffer.from("trailing")]),
    ),
  );
  const { variables } = await fixture();
  for (const changed of [
    { ...variables, [MANIFEST_VARIABLE]: "" },
    { ...variables, [BRAND_VARIABLES.favicon]: "" },
    {
      ...variables,
      [BRAND_VARIABLES.logoLight]: `${variables[BRAND_VARIABLES.logoLight]}\n`,
    },
    {
      ...variables,
      [BRAND_VARIABLES.favicon]: variables[BRAND_VARIABLES.appleTouch],
    },
    { ...variables, UNEXPECTED_INPUT: "value" },
  ])
    await assert.rejects(decodeBranding(changed));
  const manifest = JSON.parse(variables[MANIFEST_VARIABLE]);
  manifest.assets.logoLight.path = "https://external.example/logo.png";
  await assert.rejects(
    decodeBranding({
      ...variables,
      [MANIFEST_VARIABLE]: JSON.stringify(manifest),
    }),
  );
});
test("48 KiB individual, 256 KiB combined and UTF-8 5 KiB Worker boundaries fail before deployment", async () => {
  assert.doesNotThrow(() => checkVariableLimits({ A: "a".repeat(48 * 1024) }));
  assert.throws(
    () => checkVariableLimits({ A: "a".repeat(48 * 1024 + 1) }),
    /48 KiB/,
  );
  assert.throws(
    () =>
      checkVariableLimits(
        Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [
            `VARIABLE_${i}`,
            "a".repeat(48 * 1024),
          ]),
        ),
      ),
    /256 KiB/,
  );
  const { variables } = await fixture();
  const config = JSON.parse(variables[MANIFEST_VARIABLE]);
  config.locales = Object.fromEntries(
    ["zh", "en"].map((language) => [
      language,
      {
        name: "名".repeat(80),
        description: "描".repeat(300),
        footer: "页".repeat(500),
        copyright: "版".repeat(200),
      },
    ]),
  );
  assert.throws(() => parseBranding(JSON.stringify(config)));
  assert.throws(
    () =>
      buildDeploymentConfig(
        { name: "cloudflare-wiki", vars: { OTHER: "x".repeat(5121) } },
        { GITHUB_SHA: "a".repeat(40) },
      ),
    /5 KiB/,
  );
  const built = buildDeploymentConfig(
    { name: "cloudflare-wiki", vars: {} },
    { BRANDING_JSON: variables[MANIFEST_VARIABLE], GITHUB_SHA: "a".repeat(40) },
  );
  assert.equal(built.vars.PUBLIC_ORIGIN, "https://cf.emby.wiki");
  assert.ok(
    !JSON.stringify(built.vars).includes(variables[BRAND_VARIABLES.favicon]),
  );
  assert.equal(
    publicOrigin({ APP_ENV: "production", PUBLIC_ORIGIN: "https://emby.wiki" }),
    "https://emby.wiki",
  );
  assert.throws(() =>
    publicOrigin({ APP_ENV: "test", PUBLIC_ORIGIN: "https://emby.wiki" }),
  );
});
test("private local preparation and generated builds reject overwrites and validate actual deployed bytes", async (t) => {
  const root = await temporary(t);
  const bytes = await image(32, 32);
  await writeFile(join(root, "source.png"), bytes);
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      assets: { favicon: "source.png" },
      locales: { en: { footer: "Prepared footer" } },
    }),
  );
  const output = join(root, "variables");
  const report = await prepareBranding(join(root, "config.json"), output);
  assert.equal(report.directoryCreated, true);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(output, MANIFEST_VARIABLE))).mode & 0o777,
    0o600,
  );
  await assert.rejects(prepareBranding(join(root, "config.json"), output));
  await assert.rejects(
    prepareBranding(
      join(root, "config.json"),
      join(process.cwd(), "private-encoded-images"),
    ),
  );
  const variables = Object.fromEntries(
    await Promise.all(
      report.variables.map(async (name) => [
        name,
        await readFile(join(output, name), "utf8"),
      ]),
    ),
  );
  const buildRoot = join(root, "build");
  await buildBranding(variables, buildRoot);
  const config = parseBranding(variables[MANIFEST_VARIABLE]);
  const filename = basename(config.assets.favicon.path);
  await mkdir(join(buildRoot, "dist/client/assets/branding"), {
    recursive: true,
  });
  await writeFile(
    join(buildRoot, "dist/client/assets/branding", filename),
    bytes,
  );
  assert.deepEqual(parseBranding(await readBuiltBranding(buildRoot)), config);
  await writeFile(
    join(buildRoot, "dist/client/assets/branding", filename),
    Buffer.from("corrupt"),
  );
  await assert.rejects(readBuiltBranding(buildRoot));
  await buildBranding({}, buildRoot);
  assert.equal(
    JSON.parse(
      await readFile(join(buildRoot, ".branding/branding.json"), "utf8"),
    ).assets.favicon,
    undefined,
  );
  await writeFile(join(buildRoot, "public/assets/branding/unknown.png"), bytes);
  await assert.rejects(buildBranding({}, buildRoot), /Unexpected file/);
});
test("installer checks complete existing Variable quota, sends values only on stdin and verifies readback", async (t) => {
  const root = await temporary(t);
  const { variables } = await fixture();
  for (const [name, value] of Object.entries(variables))
    await writeFile(join(root, name), value);
  const stored = new Map([["EXISTING_VARIABLE", "preserve"]]);
  let writes = 0;
  const execute = () =>
    JSON.stringify([
      {
        total_count: stored.size,
        variables: [...stored].map(([name, value]) => ({ name, value })),
      },
    ]);
  const spawn = (command, args, options) => {
    writes++;
    assert.equal(command, "gh");
    assert.equal(args.includes(options.input), false);
    if (args[1] === "set") stored.set(args[2], options.input);
    else stored.delete(args[2]);
    return { status: 0 };
  };
  const report = await installBranding(root, { execute, spawn });
  assert.equal(report.readback, "verified");
  assert.equal(writes, 6);
  assert.equal(stored.get("EXISTING_VARIABLE"), "preserve");
  assert.equal(stored.get(MANIFEST_VARIABLE), variables[MANIFEST_VARIABLE]);
  const before = writes;
  for (let i = 0; i < 6; i++) stored.set(`LARGE_${i}`, "a".repeat(48 * 1024));
  await assert.rejects(installBranding(root, { execute, spawn }), /256 KiB/);
  assert.equal(writes, before);
  await assert.rejects(
    installBranding(root, {
      execute: () => JSON.stringify([{ total_count: 2, variables: [] }]),
      spawn,
    }),
    /incomplete/,
  );
});
test("private backup captures only fixed-origin branding bytes without credentials and rejects tampering", async () => {
  const { images, variables } = await fixture();
  const settings = {
    bindings: [
      {
        name: "BRANDING_JSON",
        type: "plain_text",
        text: variables[MANIFEST_VARIABLE],
      },
    ],
  };
  const captured = await captureBranding(settings, async (url, init) => {
    assert.equal(new URL(url).origin, "https://cf.emby.wiki");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, undefined);
    const role = BRAND_ROLES.find((role) => url.includes(`/${role}-`));
    const asset = JSON.parse(variables[MANIFEST_VARIABLE]).assets[role];
    return new Response(images[role], {
      headers: { "content-type": asset.mime },
    });
  });
  assert.deepEqual(captured, variables);
  await assert.rejects(
    captureBranding(
      settings,
      async () =>
        new Response("tampered", { headers: { "content-type": "image/png" } }),
    ),
  );
});
test("deployment passes encoded Repository Variables only as reusable-workflow secrets", async () => {
  const caller = await readFile(
    new URL("../.github/workflows/deploy-test.yml", import.meta.url),
    "utf8",
  );
  const called = await readFile(
    new URL("../.github/workflows/deploy-test-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(caller, /uses: \.\/\.github\/workflows\/deploy-test-run\.yml/);
  assert.match(caller, /group: deploy-cloudflare-wiki-test/);
  assert.match(called, /workflow_call:/);
  assert.doesNotMatch(called, /workflow_dispatch:|\$\{\{ vars\.WIKI_BRAND_/);
  assert.doesNotMatch(
    called,
    /upload-artifact|permissions:\s*write-all|GH_TOKEN:/,
  );
  for (const name of [MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)]) {
    assert.ok(caller.includes(`${name}: \${{ vars.${name} }}`));
    assert.ok(called.includes(`${name}: \${{ secrets.${name} }}`));
  }
});
