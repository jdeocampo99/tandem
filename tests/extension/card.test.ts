import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { renderStatusBoard } from "../../src/board/terminal.ts";
import type { BoardView } from "../../src/board/view.ts";
import {
  CARD_MESSAGE_TYPE,
  ompSessionHost,
  renderCardMessage,
  renderStatusMessage,
  STATUS_MESSAGE_TYPE,
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
  recent: [
    {
      number: 412,
      title: "Lower skip threshold",
      state: "merged",
      url: "https://github.com/acme/app/pull/412",
    },
  ],
};

const STATUS_VIEW: BoardView = {
  now: "2030-01-09T12:00:00.000Z",
  projects: ["app"],
  needsYou: [
    {
      key: "brief:req-1",
      cause: "brief",
      repoPath: "/work/app",
      project: "app",
      mark: "🙋",
      name: "Dark mode",
      text: "brief waiting for approval",
    },
  ],
  running: [],
  pullRequests: [],
  finished: 0,
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

function statusCard(details: unknown): Renderable | undefined {
  const message = {
    role: "custom",
    customType: STATUS_MESSAGE_TYPE,
    content: "plain status",
    display: true,
    details,
    timestamp: 0,
  } as const;
  return renderStatusMessage(message, { expanded: false }, {} as never) as Renderable | undefined;
}

function withColorEnabled(run: () => void): void {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "";
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
}

test("the chat draws a catch-up card in color, fitted to the chat's width", () => {
  withColorEnabled(() => {
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
});

test("a saved card whose details cannot be read falls back to OMP's plain text", () => {
  expect(card(undefined)).toBeUndefined();
  expect(card({ view: { ...VIEW, recent: [{ number: 1, title: "x", state: "gone" }] } })).toBe(
    undefined,
  );
});

test("chat status draws the shared terminal board formatter in color at chat width", () => {
  withColorEnabled(() => {
    const drawn = statusCard({ view: STATUS_VIEW });
    if (drawn === undefined) throw new Error("expected a status board");
    const lines = drawn.render(80);
    expect(lines.join("\n")).toContain("\u001b[");
    expect(lines.map(Bun.stripANSI).join("\n")).toContain("Live view: prefix+t in Herdr");
    expect(lines.map(Bun.stripANSI).join("\n")).not.toContain("Tandem code:");

    const plain = renderStatusBoard(STATUS_VIEW, { color: false, columns: 78 })
      .trimEnd()
      .split("\n");
    expect(
      lines.slice(2, 2 + plain.length - 1).map((line) => Bun.stripANSI(line).trimStart()),
    ).toEqual(plain.slice(1));
    expect(drawn.render(30).every((line) => Bun.stringWidth(line) <= 30)).toBe(true);
  });
});

test("a saved status card with malformed details falls back to OMP's plain text", () => {
  expect(statusCard(undefined)).toBeUndefined();
  expect(statusCard({ view: { ...STATUS_VIEW, needsYou: [{}] } })).toBeUndefined();
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

test("the OMP host posts the board as a status message with its text fallback", async () => {
  const sent: unknown[] = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  const host = ompSessionHost(pi, () => ({}) as ExtensionContext);
  await host.perform({
    type: "showStatus",
    view: STATUS_VIEW,
    text: "plain status",
    details: { action: "board" },
    timing: "nextTurn",
    triggerTurn: false,
  });
  expect(sent).toEqual([
    {
      message: {
        customType: STATUS_MESSAGE_TYPE,
        content: "plain status",
        display: true,
        details: { action: "board", view: STATUS_VIEW },
        attribution: "agent",
      },
      options: { deliverAs: "nextTurn" },
    },
  ]);
});
