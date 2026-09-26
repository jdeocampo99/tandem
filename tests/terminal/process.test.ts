import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { isCloseKey, watchCloseKeys } from "../../src/terminal/process.ts";

test("Esc, q, and Ctrl-C close the live view; arrow keys and other letters do not", () => {
  for (const key of ["\x1b", "q", "Q", "\x03"]) expect(isCloseKey(key)).toBe(true);
  for (const key of ["\x1b[A", "t", "\r", " "]) expect(isCloseKey(key)).toBe(false);
});

test("a terminal closes on q after other keys, and leaves raw mode", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (raw: boolean) => void;
  };
  const modes: boolean[] = [];
  input.isTTY = true;
  input.setRawMode = (raw) => {
    modes.push(raw);
  };
  const { closed } = watchCloseKeys(input);
  let done = false;
  void closed.then(() => {
    done = true;
  });
  input.write("\x1b[A");
  await Bun.sleep(0);
  expect(done).toBe(false);
  input.write("q");
  await closed;
  expect(modes).toEqual([true, false]);
});

test("releasing early gives the terminal back once, without a close key", () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (raw: boolean) => void;
  };
  const modes: boolean[] = [];
  input.isTTY = true;
  input.setRawMode = (raw) => {
    modes.push(raw);
  };
  const keys = watchCloseKeys(input);
  keys.release();
  keys.release();
  input.write("q");
  expect(modes).toEqual([true, false]);
});
