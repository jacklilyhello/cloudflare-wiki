# Deployment branding

Brand images are deployment configuration. The Worker never receives a GitHub credential and the administrator UI has no upload/save control for these assets. The settings page previews the current deployment alongside the editable D1 defaults. Only Chinese (`zh`) and English (`en`) are supported.

## Precedence and defaults

GitHub Repository Variables flow through **Deploy Production** to validated same-origin static files and the small Worker variables `BRANDING_JSON` and `PUBLIC_ORIGIN`. Explicit localized `name` and `description` values override the corresponding D1 values for reader/admin display and metadata, without writing D1. Custom logos override the built-in D1 logo choice. Unconfigured fields keep D1 behavior: default language, accent, theme and visitor theme selection are unchanged. Footer text defaults to the localized D1/deployment description; copyright is absent unless configured. An explicit empty footer/copyright string hides that text. Footer text is plain escaped text, never HTML.

No brand Variables means the existing built-in appearance, `/favicon.svg`, no Apple icon and no `og:image`. If just one logo is configured it serves both themes. With both logos, system theme and the visitor's saved light/dark selection choose the matching image. A failed logo image falls back to the other image, then the built-in mark. Hash-addressed paths change when bytes change; the HTML remains no-store and keeps its CSP and private-route noindex policy while allowing public production indexing.

`PUBLIC_ORIGIN` is fixed by Deploy Production to `https://emby.wiki`; metadata never trusts the request Host. All three public domains use this canonical origin.

## Image requirements

| Role in local configuration | Repository Variable | Accepted image |
| --- | --- | --- |
| `logoLight` | `WIKI_BRAND_LOGO_LIGHT_B64` | Single-frame PNG, JPEG or WebP; each edge 1–2048 px |
| `logoDark` | `WIKI_BRAND_LOGO_DARK_B64` | Same as light logo |
| `favicon` | `WIKI_BRAND_FAVICON_B64` | PNG, exactly 32 × 32 px |
| `appleTouch` | `WIKI_BRAND_APPLE_TOUCH_B64` | PNG, exactly 180 × 180 px |
| `ogImage` | `WIKI_BRAND_OG_IMAGE_B64` | PNG or JPEG, exactly 1200 × 630 px |

`WIKI_BRAND_MANIFEST` contains schema version 1, hashes, dimensions, MIME, same-origin paths, and optional bilingual text. It contains no encoded image. Generate it with the tool; do not hand-edit paths/hashes. No SVG, animation, rotated EXIF orientation, URL input, data URL, whitespace in Base64 or unverified header-only image is accepted. Sharp fully decodes every image. The tool preserves accepted source bytes, so prepare public images without private metadata.

Each binary is limited to **36 KiB**, which fits canonical Base64 into a **48 KiB Repository Variable**. Every Variable is checked by UTF-8 byte length; the installer checks all existing repository Variables together against **256 KiB**, and both local preparation and Actions validate related variables. The complete runtime `BRANDING_JSON`, including paths and text, must fit **5 KiB**. Other generated Worker variables are also checked against 5 KiB. There is no truncation or unverified sharding: reduce/compress the input or text when validation fails. Text maxima are 80 characters for name, 300 description, 500 footer and 200 copyright per language; the combined UTF-8 budget may be reached earlier.

GitHub may omit configuration Variables when its combined quota is exceeded. Keep headroom for unrelated Variables and rerun the installer after other configuration changes. This personal repository has no organization-variable quota to combine. A partial/missing image set or mismatched manifest stops deployment before any Cloudflare write.

Official limits: [GitHub Variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables), [Worker environment variables](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).

## Prepare and install

Use Node 24 and the locked dependencies (`npm ci`). Keep source images, configuration and generated encoded files outside the checkout. No final owner-selected images are shipped in this repository.

Create a private local configuration, with paths relative to that file, for example:

```json
{
  "assets": {
    "logoLight": "logo-light.png",
    "logoDark": "logo-dark.png",
    "favicon": "favicon.png",
    "appleTouch": "apple-touch.png",
    "ogImage": "share.jpg"
  },
  "locales": {
    "zh": { "footer": "你的中文页脚", "copyright": "你的中文版权信息" },
    "en": { "footer": "Your English footer", "copyright": "Your English copyright" }
  }
}
```

Omit unused roles/locales/fields. The output directory must not exist and must be outside the checkout:

```sh
node scripts/prepare-branding.mjs /private/path/brand.json /private/path/prepared-brand
node scripts/install-branding.mjs /private/path/prepared-brand
```

Preparation creates a directory with mode 0700 and variable files with mode 0600. Neither tool prints their contents. Installation uses your existing `gh` login to update **only this repository's six named brand Variables**, transmits values on stdin, preserves unrelated Variables, checks the combined quota, writes the manifest last, and verifies readback. It removes obsolete values only for the five brand image Variables when they are absent from the prepared configuration. It does not call Cloudflare or start a deployment. If installation fails midway, do not deploy; rerun the complete installer after correcting the reported issue. Mixed generations fail checksum validation.

For manual configuration, use GitHub Settings → Secrets and variables → Actions → Variables, or send each prepared file to `gh variable set NAME --repo jacklilyhello/cloudflare-wiki` on stdin. Check the combined quota and set `WIKI_BRAND_MANIFEST` last. Never paste encoded data into source files, issue/PR text, dispatch inputs or commands that echo it.

After successful readback, run:

```sh
gh workflow run deploy-production.yml --repo jacklilyhello/cloudflare-wiki --ref main
```

Deploy Production validates the exact main commit, decodes brand Variables to ignored `public/assets/branding/` files, builds, verifies the built image bytes, and injects only `BRANDING_JSON` and `PUBLIC_ORIGIN` into Worker configuration. Cloudflare readback checks both variables. Anonymous deployment smoke validates all configured image responses, MIME, byte lengths and hashes, plus icon/OG metadata. Check the reader in both languages, both themes and desktop/mobile sizes; the admin settings page displays the deployed previews.

Repository Variable values normally appear in runner environment logs. The top-level workflow therefore passes them to the same-commit reusable deployment workflow as **runtime secret arguments**, so the runner masks them before step headers. This is transport masking only: the authoritative values remain Repository Variables, and no additional persistent Secret or GitHub token is required. Do not replace this with direct step `env: ${{ vars.WIKI_BRAND_... }}` or enable debug dumping. No Base64 is placed in Worker variables, artifacts, source, or logs.

## Reset and restore

To return to defaults, prepare `{ "assets": {}, "locales": {} }` into a new private directory, run the installer and manually run Deploy Production. Removing all six Variables also selects the default appearance. Do not delete or change D1 settings to reset deployment branding.

Site Backup format v2 captures the **currently deployed** branding and its same-origin bytes, not pending Repository Variable changes. Isolated restoration verifies every image again and writes private `deployment-variables/` files in the new restore directory. Use that directory with `install-branding.mjs`, then Deploy Production, to restore branding when authorized. Legacy v1 archives remain readable but do not include deployment branding. No restore tool writes to GitHub or Cloudflare automatically.
