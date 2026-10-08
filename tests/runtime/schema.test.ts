import { expect, test } from "bun:test";
import {
  absolutePath,
  boolean,
  enumValue,
  isRecord,
  nonNegativeInteger,
  positiveInteger,
  singleLine,
  text,
} from "../../src/runtime/schema.ts";

function rejects(parse: () => unknown, message: string): void {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty("message", message);
    return;
  }
  throw new Error("expected parser to reject the value");
}

test("record primitives preserve text and exact default errors", () => {
  expect(text("  saved\ntext  ", "field")).toBe("  saved\ntext  ");
  expect(singleLine(" saved ", "field")).toBe(" saved ");
  for (const value of [undefined, null, 1, "", " \n ", "a\0b"]) {
    rejects(() => text(value, "field"), "field must be a non-empty string without NUL characters");
  }
  for (const separator of ["\r", "\n", "\u2028", "\u2029"]) {
    rejects(() => singleLine(`a${separator}b`, "field"), "field must be a single-line value");
  }
});

test("record primitives preserve caller trimming, whitespace acceptance, and error messages", () => {
  expect(text(" \ntext\n ", "field", { trim: true })).toBe("text");
  expect(text(" \n ", "field", { allowWhitespace: true })).toBe(" \n ");
  rejects(() => text("", "field", { allowWhitespace: true, message: "text error" }), "text error");
  rejects(() => singleLine("\0", "field", { message: "NUL error" }), "NUL error");
  rejects(() => singleLine("a\nb", "field", { lineMessage: "line error" }), "line error");
  expect(singleLine("\n text \n", "field", { trim: true })).toBe("text");
});

test("record path primitive resolves paths with the caller's text policy", () => {
  expect(absolutePath("/tmp/a/../b ", "path")).toBe("/tmp/b ");
  expect(absolutePath("/", "path")).toBe("/");
  expect(absolutePath(" \n/tmp/a/../b \n", "path", { trim: true })).toBe("/tmp/b");
  rejects(() => absolutePath("relative", "path"), "path must be absolute");
  rejects(() => absolutePath("/tmp/a\nb", "path"), "path must be a single-line value");
  rejects(
    () => absolutePath("/tmp/a\nb", "path", { lineMessage: "path line error" }),
    "path line error",
  );
});

test("record integer primitives reject non-numbers and unsafe integers without coercion", () => {
  for (const value of [0, -0, 1, Number.MAX_SAFE_INTEGER]) {
    expect(nonNegativeInteger(value, "count")).toBe(value);
  }
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    expect(positiveInteger(value, "count")).toBe(value);
  }
  for (const value of [null, true, "1", 1n, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => nonNegativeInteger(value, "count"), "count must be a non-negative integer");
    rejects(() => positiveInteger(value, "count"), "count must be a positive integer");
  }
  rejects(() => positiveInteger(0, "count"), "count must be a positive integer");
  rejects(() => nonNegativeInteger(-1, "count", "generation is invalid"), "generation is invalid");
});

test("record boolean and enum primitives retain exact values and rejection messages", () => {
  expect(boolean(false, "flag")).toBe(false);
  expect(boolean(true, "flag")).toBe(true);
  rejects(() => boolean("false", "flag"), "flag must be boolean");
  const role: "scout" | "reviewer" = enumValue("reviewer", ["scout", "reviewer"], "role");
  expect(role).toBe("reviewer");
  expect(enumValue("", [""], "role")).toBe("");
  for (const value of [undefined, null, 1, "unknown"]) {
    rejects(() => enumValue(value, ["scout"], "role"), "role has an unsupported value");
  }
  rejects(() => enumValue("scout", [], "role", "role is invalid"), "role is invalid");
});

test("record guard accepts objects and rejects null, arrays, and primitives", () => {
  expect(isRecord({ key: "value" })).toBe(true);
  expect(isRecord(new Date(0))).toBe(true);
  for (const value of [null, undefined, [], "text", 1, true, () => {}]) {
    expect(isRecord(value)).toBe(false);
  }
});
