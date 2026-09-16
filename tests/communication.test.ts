import { expect, test } from "bun:test";
import { parseTaskCommunication } from "../src/communication.ts";

const createdAt = "2030-01-02T03:04:05.000Z";

test("rejects tiny active messages whose serialized metadata exceeds the private payload bound", () => {
  const messages = Array.from({ length: 220 }, (_value, index) => ({
    id: `direction-${index}`,
    revision: index + 1,
    kind: "instruction" as const,
    text: "x",
    createdAt,
  }));

  expect(() => parseTaskCommunication({ revision: messages.length, messages })).toThrow(
    "metadata exceeds",
  );
});

test("rejects persisted answer messages without replyTo", () => {
  expect(() =>
    parseTaskCommunication({
      revision: 1,
      messages: [
        {
          id: "answer-1",
          revision: 1,
          kind: "answer",
          text: "Proceed.",
          createdAt,
        },
      ],
    }),
  ).toThrow(TypeError);
});
