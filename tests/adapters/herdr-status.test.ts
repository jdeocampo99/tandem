import { expect, test } from "bun:test";
import { createHerdrStatusReporter } from "../../src/adapters/herdr-status.ts";
import type { CommandRunner } from "../../src/contracts.ts";

const options = {
  cwd: "/tmp/tandem-status",
  agentLabel: "tandem-worker",
  environment: { HERDR_ENV: "1", HERDR_SESSION: "test-session", HERDR_PANE_ID: "w1:p1" },
};

function reporterFor(run: CommandRunner) {
  const reporter = createHerdrStatusReporter(run, options);
  if (reporter === undefined) throw new Error("Expected a reporter in the native pane fixture");
  return reporter;
}

function nativeHost() {
  const watermarks = new Map<string, number>();
  const history: (string | undefined)[] = [];
  let owner: string | undefined;
  let visible: string | undefined;
  const run: CommandRunner = async ({ argv }) => {
    const argument = (name: string) => argv[argv.indexOf(name) + 1] ?? "";
    const source = argument("--source");
    const sequence = Number(argument("--seq"));
    if (sequence > (watermarks.get(source) ?? 0)) {
      watermarks.set(source, sequence);
      if (argv[4] === "report-agent") {
        owner = source;
        visible = argument("--state");
        history.push(visible);
      } else if (argv[4] === "release-agent" && owner === source) {
        owner = undefined;
        visible = undefined;
        history.push(undefined);
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, history, state: () => visible };
}

test("lifecycle transitions preserve blocked and resumed states without duplicate reports", async () => {
  const host = nativeHost();
  const reporter = reporterFor(host.run);
  await reporter.report("working");
  await reporter.report("working");
  await reporter.report("blocked", "needs approval");
  expect(host.state()).toBe("blocked");
  await reporter.report("working");
  await reporter.report("idle", "completed");
  expect(host.state()).toBe("idle");
  await reporter.release();
  await reporter.report("working");
  expect(host.history).toEqual(["working", "blocked", "working", "idle", undefined]);
});

test("a restarted reporter is accepted despite retained native sequence watermarks", async () => {
  const host = nativeHost();
  const first = reporterFor(host.run);
  await first.report("working");
  await first.release();
  const next = reporterFor(host.run);
  await next.report("blocked");
  expect(host.state()).toBe("blocked");
  await first.release();
  expect(host.state()).toBe("blocked");
  await next.release();
  expect(host.state()).toBeUndefined();
});

for (const failure of ["exit-code", "exception"]) {
  test(`a ${failure} reporting failure does not suppress a later state update`, async () => {
    const host = nativeHost();
    let unavailable = true;
    const run: CommandRunner = async (request) => {
      if (unavailable) {
        unavailable = false;
        if (failure === "exception") throw new Error("Herdr unavailable");
        return { code: 1, stdout: "", stderr: "Herdr unavailable" };
      }
      return host.run(request);
    };
    const reporter = reporterFor(run);
    await reporter.report("working");
    expect(host.state()).toBeUndefined();
    await reporter.report("working");
    expect(host.state()).toBe("working");
    await reporter.release();
    expect(host.state()).toBeUndefined();
  });
}

test("shutdown waits for an in-flight report and cannot be undone by later activity", async () => {
  const host = nativeHost();
  let finish: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run: CommandRunner = async (request) => {
    if (request.argv[4] === "report-agent") await barrier;
    return host.run(request);
  };
  const reporter = reporterFor(run);
  const reporting = reporter.report("working");
  const releasing = reporter.release();
  const late = reporter.report("blocked");
  finish();
  await Promise.all([reporting, releasing, late]);
  expect(host.history).toEqual(["working", undefined]);
  expect(host.state()).toBeUndefined();
});

test("reporting is disabled outside Herdr or without an exact pane context", () => {
  const host = nativeHost();
  expect(createHerdrStatusReporter(host.run, { ...options, environment: {} })).toBeUndefined();
  expect(
    createHerdrStatusReporter(host.run, {
      ...options,
      environment: { HERDR_ENV: "1", HERDR_SESSION: "test-session" },
    }),
  ).toBeUndefined();
  expect(host.state()).toBeUndefined();
});
