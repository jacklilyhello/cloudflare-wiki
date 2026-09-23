import { afterEach, describe, expect, it, vi } from "vitest";
import { FileImageError, inspectImagePrefix } from "../shared/file-image";
import { FILE_LIMITS } from "../shared/files";
import {
  prepareBrowserFile,
  type ThumbnailRenderer,
} from "../src/admin/file-preparation";
import { FilesError } from "../worker/files/contracts";
import { inspectImagePrefix as workerInspect } from "../worker/files/image";

function png(width = 640, height = 480) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  let crc = 0xffffffff;
  for (const value of bytes.subarray(12, 29)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0);
  return new File([bytes], "image.png", { type: "image/png" });
}
function renderer(overrides: Partial<ThumbnailRenderer> = {}) {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 640, height: 480, close }));
  const encode = vi.fn(async () => png(320, 240));
  return { close, decode, encode, renderer: { decode, encode, ...overrides } };
}
afterEach(() => vi.unstubAllGlobals());

describe("browser file preparation", () => {
  it("extracts the parser without changing Worker error classes or status", () => {
    const invalid = new Uint8Array(33);
    expect(() =>
      inspectImagePrefix(invalid, "image/png", 33, "source"),
    ).toThrow(FileImageError);
    expect(() => workerInspect(invalid, "image/png", 33, "source")).toThrow(
      FilesError,
    );
    try {
      workerInspect(invalid, "image/png", 33, "source");
    } catch (error) {
      expect(error).toMatchObject({ status: 415 });
    }
    try {
      workerInspect(
        new Uint8Array(),
        "application/octet-stream",
        FILE_LIMITS.sourceBytes + 1,
        "source",
      );
    } catch (error) {
      expect(error).toMatchObject({ status: 413 });
    }
  });
  it("hashes an attachment and keeps unsupported types as downloads", async () => {
    const platform = renderer();
    const file = new File(["abc"], "page.svg", { type: "image/svg+xml" });
    const result = await prepareBrowserFile(
      file,
      { thumbnail: true },
      platform.renderer,
    );
    expect(result.source.body).toBe(file);
    expect(result.source.input).toEqual({
      bytes: 3,
      mimeHint: "application/octet-stream",
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(result.thumbnail).toBeNull();
    expect(platform.decode).not.toHaveBeenCalled();
  });
  it("validates headers before decode, scales a thumbnail, then hashes the encoded bytes", async () => {
    const phases: string[] = [];
    const platform = renderer();
    const result = await prepareBrowserFile(
      png(),
      { thumbnail: true, onPhase: (phase) => phases.push(phase) },
      platform.renderer,
    );
    expect(phases).toEqual(["checking", "hashing", "thumbnail"]);
    expect(platform.encode).toHaveBeenCalledWith(
      expect.objectContaining({ width: 640, height: 480 }),
      320,
      240,
    );
    expect(result.thumbnail?.input).toMatchObject({
      bytes: 33,
      mimeHint: "image/png",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.thumbnailOmitted).toBe(false);
    expect(platform.close).toHaveBeenCalledOnce();
  });
  it("does not enlarge a small image or decode when thumbnails are disabled", async () => {
    const platform = renderer({
      decode: async () => ({ width: 1, height: 2, close: vi.fn() }),
    });
    await prepareBrowserFile(png(1, 2), { thumbnail: true }, platform.renderer);
    expect(platform.encode).toHaveBeenCalledWith(expect.anything(), 1, 2);
    const disabled = renderer();
    await prepareBrowserFile(png(), { thumbnail: false }, disabled.renderer);
    expect(disabled.decode).not.toHaveBeenCalled();
  });
  it.each([
    ["empty", new File([], "empty")],
    [
      "source bytes",
      new File([new Uint8Array(FILE_LIMITS.sourceBytes + 1)], "large"),
    ],
    [
      "image bytes",
      new File([new Uint8Array(FILE_LIMITS.imageBytes + 1)], "large.png", {
        type: "image/png",
      }),
    ],
    ["image pixels", png(5001, 5000)],
    [
      "false image header",
      new File(["<svg></svg>"], "fake.png", { type: "image/png" }),
    ],
  ])("rejects %s before hash or decode", async (_label, file) => {
    const platform = renderer();
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(
      prepareBrowserFile(file, { thumbnail: true }, platform.renderer),
    ).rejects.toBeInstanceOf(FileImageError);
    expect(read).not.toHaveBeenCalled();
    expect(platform.decode).not.toHaveBeenCalled();
  });
  it.each([
    ["encoding unavailable", null],
    [
      "too many bytes",
      new Blob([new Uint8Array(FILE_LIMITS.thumbnailBytes + 1)], {
        type: "image/png",
      }),
    ],
    ["oversize header", png(321, 240)],
    ["non-raster output", new Blob(["<svg/>"], { type: "image/svg+xml" })],
    ["invalid raster header", new Blob(["broken"], { type: "image/png" })],
  ])(
    "omits an optional thumbnail on %s and preserves the source",
    async (_label, output) => {
      const platform = renderer({ encode: async () => output });
      const file = png();
      const result = await prepareBrowserFile(
        file,
        { thumbnail: true },
        platform.renderer,
      );
      expect(result.thumbnail).toBeNull();
      expect(result.thumbnailOmitted).toBe(true);
      expect(result.source.body).toBe(file);
      expect(platform.close).toHaveBeenCalledOnce();
    },
  );
  it("checks decoded dimensions and closes a rejected bitmap", async () => {
    const close = vi.fn();
    const platform = renderer({
      decode: async () => ({ width: 100000, height: 100000, close }),
    });
    const result = await prepareBrowserFile(
      png(),
      { thumbnail: true },
      platform.renderer,
    );
    expect(result.thumbnailOmitted).toBe(true);
    expect(platform.encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("treats decoder failure as optional-thumbnail failure", async () => {
    const result = await prepareBrowserFile(
      png(),
      { thumbnail: true },
      renderer({
        decode: async () => {
          throw new Error("decode failed");
        },
      }).renderer,
    );
    expect(result.thumbnailOmitted).toBe(true);
    expect(result.source).toBeDefined();
  });
  it("stops after a cancelled decode and still closes its bitmap", async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const platform = renderer({
      decode: async () => {
        controller.abort();
        return { width: 640, height: 480, close };
      },
    });
    await expect(
      prepareBrowserFile(
        png(),
        { thumbnail: true, signal: controller.signal },
        platform.renderer,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(platform.encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not swallow cancellation during thumbnail encoding", async () => {
    const controller = new AbortController();
    const platform = renderer({
      encode: async () => {
        controller.abort();
        return png(320, 240);
      },
    });
    await expect(
      prepareBrowserFile(
        png(),
        { thumbnail: true, signal: controller.signal },
        platform.renderer,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(platform.close).toHaveBeenCalledOnce();
  });
  it("hashes the maximum attachment with one bounded full-file read", async () => {
    const file = new File(
      [new Uint8Array(FILE_LIMITS.sourceBytes)],
      "maximum.bin",
    );
    const read = vi.spyOn(file, "arrayBuffer");
    const result = await prepareBrowserFile(file, { thumbnail: false });
    expect(read).toHaveBeenCalledOnce();
    expect(result.source.input.bytes).toBe(FILE_LIMITS.sourceBytes);
    expect(result.source.input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source.body).toBe(file);
  });
  it("limits browser header inspection to one MiB and never decodes an invalid prefix", async () => {
    const file = new File([new Uint8Array(2 * 1024 * 1024)], "large.jpg", {
      type: "image/jpeg",
    });
    const slice = vi.spyOn(file, "slice");
    const platform = renderer();
    await expect(
      prepareBrowserFile(file, { thumbnail: true }, platform.renderer),
    ).rejects.toBeInstanceOf(FileImageError);
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 1024 * 1024);
    expect(platform.decode).not.toHaveBeenCalled();
  });
  it("uses native canvas without URLs and clears its backing store", async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: (blob: Blob) => void) =>
      callback(png(320, 240)),
    );
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob,
    };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 640, height: 480, close })),
    );
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const result = await prepareBrowserFile(png(), { thumbnail: true });
    expect(result.thumbnail).not.toBeNull();
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/webp",
      0.8,
    );
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 320, 240);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
});
