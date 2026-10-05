import { expect, test } from "bun:test";
import { processArguments } from "../../../src/terminal-backend/tern/process-reader.ts";

test("native argv decoding retains argument boundaries and ignores everything after argc arguments", () => {
  const tail = new TextEncoder().encode(
    "/bin/program\0\0program\0an argument with spaces\0\0ignored trailing bytes\0",
  );
  const bytes = new Uint8Array(4 + tail.length);
  new DataView(bytes.buffer).setInt32(0, 3, true);
  bytes.set(tail, 4);
  expect(processArguments(bytes)).toEqual(["program", "an argument with spaces", ""]);
});
