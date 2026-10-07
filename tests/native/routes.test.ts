import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { isApprovalVerb } from "../../src/native/actions.ts";
import {
  Action,
  ActionEnvelope,
  LINK_KINDS,
  NOTICE_CODES,
  nativeAnswerLink,
  nativeLink,
  VIEW_KINDS,
} from "../../src/native/contract.ts";
import { QUICK_SCOPE_CHOICES } from "../../src/tasks/quick.ts";
import { withParity } from "../evals/tern-parity/inventory.ts";

const plugin = (name: string) =>
  readFile(new URL(`../../tern-plugin/${name}`, import.meta.url), "utf8");

test("T3: plugin.toml blocks, host.luau registrations and VIEW_KINDS name the same views", async () => {
  const manifest = [...(await plugin("plugin.toml")).matchAll(/^id = "([\w-]+)"$/gmu)]
    .map((match) => match[1])
    .filter((id) => id !== "tandem");
  const registered = [
    ...(await plugin("host.luau")).matchAll(
      /tern\.block\.define\("([\w-]+)", lazy\(function\(\) return require\("\.\/([\w-]+)"\)/gu,
    ),
  ].map(([, kind, module]) => {
    expect(module).toBe(kind);
    return kind;
  });
  expect(registered.toSorted()).toEqual(manifest.toSorted());
  // `prs` has no block: Show PRs opens the first cached `pr` view.
  expect(registered.toSorted()).toEqual(VIEW_KINDS.filter((kind) => kind !== "prs").toSorted());
});

test("T3: every reply link Tandem writes routes to an open action the contract accepts", async () => {
  await withParity(async ({ host, briefId }) => {
    const ids = { task: "port", brief: briefId, pr: "281" } as const;
    for (const kind of LINK_KINDS) {
      const before = host.cli.length;
      expect(await host.link(nativeLink(kind, ids[kind]))).toBe(true);
      // The newly focused pane also reports a visit; the link sends exactly one open.
      const sent = host.cli
        .slice(before)
        .map((run) => ActionEnvelope.parse(JSON.parse(run.stdin ?? "")).action);
      // A reply link only shows; the choice is made in the view it opens.
      expect(sent.filter((action) => isApprovalVerb(action.verb))).toEqual([]);
      const opens = sent.filter((action) => action.verb === "open");
      expect(opens).toEqual([
        {
          verb: "open",
          ref:
            kind === "task"
              ? { kind, taskId: ids.task }
              : kind === "brief"
                ? { kind, requestId: ids.brief }
                : { kind, number: 281 },
        },
      ]);
    }
    expect(() => nativeLink("pr", "owner/repo#281")).toThrow();
    expect(() => nativeLink("task", "../escape")).toThrow();
  });
});

test("T3: every scope-question answer link routes to a quick-answer action the contract accepts", async () => {
  await withParity(async ({ host }) => {
    for (const choice of QUICK_SCOPE_CHOICES) {
      const before = host.cli.length;
      expect(await host.link(nativeAnswerLink("port", "job-1", choice))).toBe(true);
      const answers = host.cli
        .slice(before)
        .map((run) => ActionEnvelope.parse(JSON.parse(run.stdin ?? "")).action)
        .filter((action) => action.verb === "quick-answer");
      expect(answers).toEqual([
        { verb: "quick-answer", taskId: "port", questionId: "job-1", choice },
      ]);
    }
    expect(() => nativeAnswerLink("../escape", "job-1", "proceed")).toThrow();
  });
});

/** Every verb a plugin file names as a string literal, whether it builds or compares an action. */
async function sentVerbs(name: string): Promise<readonly Action["verb"][]> {
  const verbs = Action.options.map((option) => option.shape.verb.value);
  return [...(await plugin(name)).matchAll(/["']([\w-]+)["']/gu)].flatMap(([, literal]) => {
    const known = verbs.find((verb) => verb === literal);
    return known === undefined ? [] : [known];
  });
}

test("window commands and reply links send only navigational or reply verbs", async () => {
  const verbs = await sentVerbs("window.luau");
  expect(verbs).toContain("open");
  expect(verbs.filter(isApprovalVerb)).toEqual([]);
});

test("only the blocks Tandem proves for them send approval-bearing verbs", async () => {
  // pr-content.luau is the PR pane's content, embedded by both the PR and task blocks.
  const provable = [
    "brief.luau",
    "pr.luau",
    "pr-content.luau",
    "quick-task.luau",
    "setup.luau",
    "task.luau",
  ];
  const names = (await readdir(new URL("../../tern-plugin/", import.meta.url))).filter((name) =>
    name.endsWith(".luau"),
  );
  for (const name of names) {
    const approvals = (await sentVerbs(name)).filter(isApprovalVerb);
    if (!provable.includes(name)) expect({ name, approvals }).toEqual({ name, approvals: [] });
  }
  expect(await sentVerbs("brief.luau")).toEqual(
    expect.arrayContaining(["brief-approve", "brief-request-changes"]),
  );
  expect(await sentVerbs("task.luau")).toEqual(expect.arrayContaining(["restart", "steer"]));
  expect(await sentVerbs("pr-content.luau")).toEqual(
    expect.arrayContaining(["pr-comment", "review-submit"]),
  );
  expect(await sentVerbs("setup.luau")).toContain("setup-save");
});

test("rt.luau has one toast for every notice code but failed, which takes the screen's title", async () => {
  const table = (await plugin("rt.luau")).match(/local NOTICES[^\n]*\n([\s\S]*?)\n\}/u)?.[1] ?? "";
  const toasts = [...table.matchAll(/\["([\w-]+)"\]\s*=/gu)].map(([, code]) => code);
  expect(toasts.toSorted()).toEqual(NOTICE_CODES.filter((code) => code !== "failed").toSorted());
});
