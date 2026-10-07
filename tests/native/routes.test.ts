import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ActionEnvelope, LINK_KINDS, nativeLink, VIEW_KINDS } from "../../src/native/contract.ts";
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
      const opens = host.cli
        .slice(before)
        .map((run) => ActionEnvelope.parse(JSON.parse(run.stdin ?? "")).action)
        .filter((action) => action.verb === "open");
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
