import { expect, test } from "bun:test";
import { nativeCatchUpView, shouldAutoShowCatchUp } from "../../src/memory/native-view.ts";
import { catchUpView, emptyMemory } from "../../src/memory/workstream.ts";

test("catch-up automatically shows at one hour only after meaningful changes and a known prior visit", () => {
  const input = {
    now: "2030-01-01T12:00:00Z",
    lastVisibleAt: "2030-01-01T11:00:00Z",
    previousSignature: "before",
    currentSignature: "after",
  };
  expect(shouldAutoShowCatchUp(input)).toBe(true);
  expect(shouldAutoShowCatchUp({ ...input, lastVisibleAt: "2030-01-01T11:00:01Z" })).toBe(false);
  expect(shouldAutoShowCatchUp({ ...input, currentSignature: "before" })).toBe(false);
  expect(shouldAutoShowCatchUp({ now: input.now, currentSignature: "after" })).toBe(false);
  expect(shouldAutoShowCatchUp({ ...input, lastVisibleAt: "broken" })).toBe(false);
});

test("native catch-up reuses the memory view for merged PRs and where we left off", () => {
  const memory = {
    ...emptyMemory("tern"),
    sections: { now: "Approve the brief", "last-handoff": "Earlier work" },
  };
  const recent = [
    {
      number: 276,
      title: "Panel",
      state: "merged" as const,
      url: "https://github.com/acme/app/pull/276",
    },
  ];
  const workstream = catchUpView({
    memory,
    path: "/notes/MEMORY.md",
    savedAt: "2030-01-01T10:00:00Z",
    now: "2030-01-01T12:00:00Z",
    recent,
  });
  const view = nativeCatchUpView(
    "/repo",
    [workstream, workstream],
    [
      {
        key: "task:1",
        cause: "blocked",
        name: "Panel width",
        text: "blocked: same problems twice",
        project: "repo",
        mark: "!",
      },
    ],
  );
  expect(view.merged).toHaveLength(1);
  expect(view.whereWeLeftOff[0]?.text).toBe("Approve the brief");
  expect(view.blocked[0]?.reason).toBe("same problems twice");
  expect(view.needsYou).toHaveLength(0);
});
