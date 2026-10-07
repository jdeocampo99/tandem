import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AlertObservation,
  deliverNewAlerts,
  markNativeAlertsRead,
  nativeAlertCounts,
} from "../../src/native/store.ts";

type Seen = Readonly<{
  events?: readonly (string | undefined)[];
  draft?: string;
  routing?: readonly string[];
  rows?: readonly string[];
}>;

/** One task whose events alert by name, its draft, and needs-you rows in board order. */
function observation(seen: Seen): AlertObservation<string> {
  return {
    tasks: [
      {
        taskId: "task-1",
        events: (seen.events ?? []).map((alert, index) => ({ seq: index + 1, alert })),
        ...(seen.draft === undefined
          ? {}
          : { draft: { identity: seen.draft, alert: `done ${seen.draft}` } }),
      },
    ],
    needsYou: [
      ...(seen.routing ?? []).map((identity) => ({
        claim: "routing" as const,
        identity,
        alert: `route ${identity}`,
      })),
      ...(seen.rows ?? []).map((identity) => ({
        claim: "row" as const,
        identity,
        alert: `row ${identity}`,
      })),
    ],
  };
}

async function withStore(body: (home: string, project: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tdm-alerts-"));
  try {
    await body(home, join(home, "repo"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the first observation is a silent baseline; each later transition is sent once", async () => {
  await withStore(async (home, project) => {
    const sent: string[] = [];
    const deliver = (seen: Seen) =>
      deliverNewAlerts(home, project, async () => observation(seen), {
        send: async (alert) => {
          sent.push(alert);
        },
        failed: async () => {
          throw new Error("no delivery fails here");
        },
      });
    await deliver({ events: ["asked"], draft: "acme/app#1", routing: ["r1"], rows: ["b1"] });
    expect(sent).toEqual([]);
    await deliver({
      events: ["asked", undefined, "stuck"],
      draft: "acme/app#2",
      routing: ["r1", "r2"],
      rows: ["b1", "b2"],
    });
    expect(sent).toEqual(["stuck", "done acme/app#2", "route r2", "row b2"]);
    // A routing claim survives the row's absence; a board row claim does not.
    await deliver({ events: ["asked", undefined, "stuck"], draft: "acme/app#2" });
    await deliver({
      events: ["asked", undefined, "stuck"],
      draft: "acme/app#2",
      routing: ["r1", "r2"],
      rows: ["b1", "b2"],
    });
    expect(sent.slice(4)).toEqual(["row b1", "row b2"]);
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 6, unread: 6 });
  });
});

test("a failed send keeps its claim, is never retried and does not count toward the bell", async () => {
  await withStore(async (home, project) => {
    const failed: string[] = [];
    const deliver = (seen: Seen, send: (alert: string) => Promise<void>) =>
      deliverNewAlerts(home, project, async () => observation(seen), {
        send,
        failed: async (alert, error) => {
          failed.push(`${alert}: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
    const quiet = async () => {};
    await deliver({}, quiet);
    await deliver({ rows: ["b1", "b2"] }, async (alert) => {
      if (alert === "row b1") throw new Error("unknown delivery");
    });
    expect(failed).toEqual(["row b1: unknown delivery"]);
    await deliver({ rows: ["b1", "b2"] }, async () => {
      throw new Error("claimed alerts must not be sent again");
    });
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 1, unread: 1 });
  });
});

test("an observation that throws claims nothing", async () => {
  await withStore(async (home, project) => {
    const sent: string[] = [];
    const delivery = {
      send: async (alert: string) => {
        sent.push(alert);
      },
      failed: async () => {},
    };
    await deliverNewAlerts(home, project, async () => observation({}), delivery);
    await expect(
      deliverNewAlerts(
        home,
        project,
        async () => {
          throw new Error("Native alerts cannot advance across unreadable task events");
        },
        delivery,
      ),
    ).rejects.toThrow("unreadable task events");
    await deliverNewAlerts(home, project, async () => observation({ events: ["asked"] }), delivery);
    expect(sent).toEqual(["asked"]);
  });
});

test("marking read keeps later deliveries unread and never passes what was delivered", async () => {
  await withStore(async (home, project) => {
    const delivery = { send: async () => {}, failed: async () => {} };
    await markNativeAlertsRead(home, project, 5);
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 0, unread: 0 });
    await deliverNewAlerts(home, project, async () => observation({}), delivery);
    await deliverNewAlerts(home, project, async () => observation({ rows: ["b1"] }), delivery);
    const captured = await nativeAlertCounts(home, project);
    await deliverNewAlerts(
      home,
      project,
      async () => observation({ rows: ["b1", "b2"] }),
      delivery,
    );
    await markNativeAlertsRead(home, project, captured.delivered);
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 2, unread: 1 });
    await markNativeAlertsRead(home, project, 1);
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 2, unread: 1 });
    await markNativeAlertsRead(home, project, 9);
    expect(await nativeAlertCounts(home, project)).toEqual({ delivered: 2, unread: 0 });
    await expect(markNativeAlertsRead(home, project, -1)).rejects.toThrow(
      "Invalid alert read cursor",
    );
  });
});
