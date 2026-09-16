import { describe, expect, it, vi } from "vitest";
import { makeSdkLoggerBridge } from "../../src/infrastructure/wire/SdkLoggerBridge";
import { initLogging } from "../../src/app/logging";

describe("SDK logging privacy", () => {
  it("preserves severity without SDK strings, nested events or error bodies", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const bridge = makeSdkLoggerBridge(initLogging("debug"));
      const marker = "SDK_PRIVATE_CONTEXT_MARKER";
      for (const level of ["debug", "info", "warn", "error"] as const) {
        bridge[level](`SDK exception: ${marker}`, { payload: { content: marker } }, new Error(marker));
      }
      const output = stderr.mock.calls.map(([line]) => String(line));
      expect(output.join("")).not.toContain(marker);
      expect(output.map(line => JSON.parse(line))).toEqual(
        ["debug", "info", "warn", "error"].map(level => ({
          level, msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String),
        })),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
