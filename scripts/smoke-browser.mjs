import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { createSmokeGet, validateSmokeBaseUrl } from "./smoke-policy.mjs";
import { check } from "./smoke-test.mjs";

// Use the runner's installed Chrome with its sandbox and normal browser defaults.
// No stealth flags, challenge solvers, security exceptions, or administrator login.
const base = process.env.SMOKE_BASE_URL;
const origin = validateSmokeBaseUrl(base).origin;
assert.ok(
  origin.startsWith("https:"),
  "Browser smoke is for public production origins",
);
const canonical =
  origin === "https://www.emby.wiki" ? "https://emby.wiki" : origin;
const profile = await mkdtemp(join(tmpdir(), "wiki-production-browser-"));
const childEnv = { ...process.env };
delete childEnv.CLOUDFLARE_API_TOKEN;
delete childEnv.ADMIN_SETUP_TOKEN;
const chrome = spawn(
  "google-chrome",
  [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { env: childEnv, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const chromeClosed = new Promise((resolve) => chrome.once("close", resolve));
let sequence = 0;
let buffer = "";
const decoder = new StringDecoder("utf8");
const pending = new Map();
let onEvent = () => {};
function rejectPending() {
  for (const request of pending.values())
    request.reject(new Error("Chrome transport closed"));
  pending.clear();
}
chrome.on("error", rejectPending);
chrome.on("exit", rejectPending);
chrome.stdio[4].on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let end = buffer.indexOf("\0");
  while (end !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error)
          request.reject(
            new Error(`Chrome command failed: ${message.error.code}`),
          );
        else request.resolve(message.result);
      }
    } else onEvent(message);
    end = buffer.indexOf("\0");
  }
});
async function command(method, params = {}, sessionId) {
  const id = ++sequence;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Chrome command timed out"));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    chrome.stdio[3].write(
      `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
    );
  });
}

try {
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const call = (method, params) => command(method, params, sessionId);
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: base });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await call("Runtime.evaluate", {
      expression:
        "JSON.stringify({origin:location.origin,reader:!!document.getElementById('reader-data')})",
      returnByValue: true,
    });
    if (state.result?.type === "string") {
      const value = JSON.parse(state.result.value);
      if (value.origin === canonical && value.reader) {
        ready = true;
        break;
      }
    }
    await delay(1000);
  }
  assert.ok(
    ready,
    "Chrome must reach the production reader without solving an interactive challenge",
  );

  let active;
  onEvent = (message) => {
    if (
      message.sessionId !== sessionId ||
      message.method !== "Fetch.requestPaused"
    )
      return;
    const { requestId, request, responseStatusCode, responseHeaders } =
      message.params;
    const capturedRequest =
      active && request.url === active.url && request.method === "GET"
        ? active
        : undefined;
    (async () => {
      try {
        if (!capturedRequest) return;
        const headers = new Headers(
          responseHeaders.map(({ name, value }) => [name, value]),
        );
        let bytes = null;
        if (![301, 302, 303, 307, 308, 204, 304].includes(responseStatusCode)) {
          const body = await call("Fetch.getResponseBody", { requestId });
          bytes = Buffer.from(
            body.body,
            body.base64Encoded ? "base64" : "utf8",
          );
        }
        capturedRequest.resolve(
          new Response(bytes, { status: responseStatusCode, headers }),
        );
      } catch (error) {
        capturedRequest?.reject(error);
      } finally {
        await call("Fetch.continueRequest", { requestId });
      }
    })().catch((error) => {
      capturedRequest?.reject(error);
    });
  };
  await call("Fetch.enable", {
    patterns: [{ urlPattern: `${canonical}/*`, requestStage: "Response" }],
  });
  async function browserFetch(target) {
    assert.equal(
      target.origin,
      canonical,
      "Browser requests remain same-origin",
    );
    let timer;
    const captured = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Browser HTTP response timed out")),
        30_000,
      );
      active = { url: target.href, resolve, reject };
    });
    const evaluated = call("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(target.href)},{method:'GET',redirect:'manual',cache:'no-store',credentials:'same-origin'}).then(r=>r.arrayBuffer()).then(()=>true).catch(()=>false)`,
      awaitPromise: true,
      returnByValue: true,
    });
    try {
      const [response, evaluation] = await Promise.all([captured, evaluated]);
      assert.equal(evaluation.result?.value, true, "Browser GET completed");
      return response;
    } finally {
      clearTimeout(timer);
      active = undefined;
    }
  }
  await check(createSmokeGet(base, browserFetch));
} finally {
  try {
    await command("Browser.close");
  } catch {
    chrome.kill("SIGTERM");
  }
  await Promise.race([
    chromeClosed,
    delay(10_000, null, { ref: false }).then(async () => {
      chrome.kill("SIGKILL");
      await chromeClosed;
    }),
  ]);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
