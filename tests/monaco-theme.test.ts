import { describe, expect, it, vi } from "vitest";
import { createMonacoThemeBinding } from "../src/admin/monaco-theme";

function fixture(theme: unknown = "system", dark = false) {
  const state = { theme, dark };
  const callbacks: (() => void)[] = [];
  const disconnect = vi.fn();
  const observe = vi.fn((changed: () => void) => {
    callbacks.push(changed);
    return disconnect;
  });
  const apply = vi.fn<(value: string) => void>();
  const retain = createMonacoThemeBinding(
    {
      theme: () => state.theme,
      systemDark: () => state.dark,
      observe,
    },
    apply,
  );
  const changed = () => callbacks.at(-1)?.();
  return { state, callbacks, disconnect, observe, apply, retain, changed };
}

describe("shared Monaco appearance binding", () => {
  it("uses one watcher for concurrent editor and diff instances until the last disposal", () => {
    const test = fixture("dark");
    const editor = test.retain();
    const diff = test.retain();
    expect(test.observe).toHaveBeenCalledTimes(1);
    expect(test.apply).toHaveBeenCalledExactlyOnceWith("wiki-night");
    editor();
    editor();
    expect(test.disconnect).not.toHaveBeenCalled();
    test.state.theme = "light";
    test.changed();
    expect(test.apply).toHaveBeenLastCalledWith("wiki-paper");
    diff();
    expect(test.disconnect).toHaveBeenCalledTimes(1);
    test.state.theme = "dark";
    test.changed();
    expect(test.apply).toHaveBeenCalledTimes(2);
  });

  it("follows media changes only while the document follows the system", () => {
    const test = fixture();
    const release = test.retain();
    test.state.dark = true;
    test.changed();
    expect(test.apply.mock.calls.map(([theme]) => theme)).toEqual([
      "wiki-paper",
      "wiki-night",
    ]);
    test.state.theme = "light";
    test.changed();
    test.state.dark = false;
    test.changed();
    test.state.dark = true;
    test.changed();
    expect(test.apply).toHaveBeenCalledTimes(3);
    expect(test.apply).toHaveBeenLastCalledWith("wiki-paper");
    test.state.theme = "dark";
    test.changed();
    test.state.dark = false;
    test.changed();
    expect(test.apply).toHaveBeenCalledTimes(4);
    expect(test.apply).toHaveBeenLastCalledWith("wiki-night");
    test.state.theme = "system";
    test.changed();
    expect(test.apply).toHaveBeenLastCalledWith("wiki-paper");
    release();
  });

  it("uses the system fallback for missing or invalid attributes without redundant theme changes", () => {
    const test = fixture(undefined, true);
    const release = test.retain();
    for (const value of [undefined, "", "invalid", "system"]) {
      test.state.theme = value;
      test.changed();
    }
    expect(test.apply).toHaveBeenCalledExactlyOnceWith("wiki-night");
    release();
  });

  it("reacquires cleanly after effect cleanup and ignores queued callbacks from the disposed watcher", () => {
    const test = fixture("light");
    const first = test.retain();
    const staleCallback = test.callbacks[0];
    first();
    test.state.theme = "dark";
    const second = test.retain();
    expect(test.observe).toHaveBeenCalledTimes(2);
    expect(test.apply).toHaveBeenLastCalledWith("wiki-night");
    test.state.theme = "light";
    staleCallback?.();
    expect(test.apply).toHaveBeenCalledTimes(2);
    test.changed();
    expect(test.apply).toHaveBeenCalledTimes(3);
    second();
    expect(test.disconnect).toHaveBeenCalledTimes(2);
  });

  it("synchronizes a newly mounted view before an attribute notification has arrived", () => {
    const test = fixture("light");
    const first = test.retain();
    test.state.theme = "dark";
    const second = test.retain();
    expect(test.apply).toHaveBeenLastCalledWith("wiki-night");
    expect(test.observe).toHaveBeenCalledTimes(1);
    first();
    second();
  });

  it("disconnects on initial theme failure and allows a later deliberate mount", () => {
    const test = fixture("dark");
    test.apply.mockImplementationOnce(() => {
      throw new Error("Local theme initialization failure");
    });
    expect(() => test.retain()).toThrow("Local theme initialization failure");
    expect(test.disconnect).toHaveBeenCalledTimes(1);
    test.changed();
    expect(test.apply).toHaveBeenCalledTimes(1);
    const release = test.retain();
    expect(test.observe).toHaveBeenCalledTimes(2);
    expect(test.apply).toHaveBeenLastCalledWith("wiki-night");
    release();
    expect(test.disconnect).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed watcher registration or corrupt another mounted view", () => {
    const test = fixture();
    test.observe.mockImplementationOnce(() => {
      throw new Error("Local watcher failure");
    });
    expect(() => test.retain()).toThrow("Local watcher failure");
    expect(test.apply).not.toHaveBeenCalled();
    const first = test.retain();
    test.state.theme = "dark";
    test.apply.mockImplementationOnce(() => {
      throw new Error("Local theme update failure");
    });
    expect(() => test.retain()).toThrow("Local theme update failure");
    first();
    expect(test.disconnect).toHaveBeenCalledTimes(1);
    const third = test.retain();
    expect(test.apply).toHaveBeenLastCalledWith("wiki-night");
    third();
    expect(test.disconnect).toHaveBeenCalledTimes(2);
  });
});
