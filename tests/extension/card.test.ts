import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  CARD_MESSAGE_TYPE,
  ompSessionHost,
  renderCardMessage,
} from "../../src/extension/omp-host.ts";
import { renderCatchUpCard } from "../../src/memory/view.ts";
import type { CatchUpView } from "../../src/memory/workstream.ts";

const VIEW: CatchUpView = {
  name: "tia",
  path: "/notes/tia/MEMORY.md",
  savedOn: "2030-01-06",
  age: "3 days ago",
  today: "2030-01-09",
  due: [{ text: "check the rate on 2030-01-09 because #412 merged", due: "2030-01-09" }],
  later: [],
  now: "Rolling out.",
  extra: [],
  recent: [{ number: 412, title: "Lower skip threshold", state: "merged" }],
};

type Renderable = { render(width: number): readonly string[]; invalidate?(): void };

function card(details: unknown): Renderable | undefined {
  const message = {
    role: "custom",
    customType: CARD_MESSAGE_TYPE,
    content: "plain card",
    display: true,
    details,
    timestamp: 0,
  } as const;
  return renderCardMessage(message, { expanded: false }, {} as never) as Renderable | undefined;
}

test("the chat draws a catch-up card in color, fitted to the chat's width", () => {
  const drawn = card({ view: VIEW });
  if (drawn === undefined) throw new Error("expected a card");
  const lines = drawn.render(80);
  expect(lines.join("\n")).toContain("\u001b[");
  const plain = renderCatchUpCard(VIEW, { color: false }).trimEnd().split("\n");
  // Only the name differs: in color it is a padded badge.
  expect(Bun.stripANSI(lines[1] ?? "")).toBe("  tia  · 3 days ago");
  expect(lines.slice(2).map((line) => Bun.stripANSI(line).trimStart())).toEqual([
    ...plain.slice(1),
    "",
  ]);
  expect(drawn.render(30).every((line) => Bun.stringWidth(line) <= 30)).toBe(true);
});

test("a saved card whose details cannot be read falls back to OMP's plain text", () => {
  expect(card(undefined)).toBeUndefined();
  expect(card({ view: { ...VIEW, recent: [{ number: 1, title: "x", state: "gone" }] } })).toBe(
    undefined,
  );
});

test("the OMP host posts a card between the tool block and the model's reply", async () => {
  const sent: unknown[] = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  const host = ompSessionHost(pi, () => ({}) as ExtensionContext);
  await host.perform({ type: "showCard", view: VIEW, text: "plain card" });
  expect(sent).toEqual([
    {
      message: {
        customType: CARD_MESSAGE_TYPE,
        content: "plain card",
        display: true,
        details: { view: VIEW },
        attribution: "agent",
      },
      options: { deliverAs: "aside" },
    },
  ]);
});
