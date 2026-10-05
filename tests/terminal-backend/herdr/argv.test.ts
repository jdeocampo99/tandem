import { expect, test } from "bun:test";
import type { CommandRequest, CommandRunner } from "../../../src/contracts.ts";
import { PIN_CASES } from "./argv-cases.ts";

/**
 * The exact Herdr conversation behind every terminal operation Tandem performs, and what the
 * caller observes, against `__snapshots__/argv.test.ts.snap`. The cases in `argv-cases.ts` map
 * each operation onto the code under test; this file and the snapshot stay fixed across a
 * refactor. Temporary roots and the per-process status source vary between runs. A request's
 * environment keeps only what Tandem set or changed: the inherited rest differs on every machine and
 * can hold credentials.
 */
function normalized(value: unknown): unknown {
  const text = JSON.stringify(value ?? null)
    .replace(/\/[^"\s']*?tandem-pin-[A-Za-z0-9]+/g, "<tmp>")
    .replace(/tandem:[0-9a-f-]{36}/g, "tandem:<source>")
    .replace(/coordinator(-[0-9a-f]{16}){3}\.sh/g, "coordinator-<script>.sh");
  return JSON.parse(text);
}

function ownEnvironment(request: CommandRequest): CommandRequest {
  if (request.env === undefined) return request;
  const own = Object.entries(request.env).filter(([key, value]) => process.env[key] !== value);
  return { ...request, env: Object.fromEntries(own) };
}

for (const pin of PIN_CASES) {
  test(`herdr conversation: ${pin.name}`, async () => {
    const calls: CommandRequest[] = [];
    const record = (run: CommandRunner): CommandRunner => {
      return async (request) => {
        if (request.argv[0] === "herdr") calls.push(ownEnvironment(request));
        return run(request);
      };
    };
    let outcome: unknown;
    try {
      outcome = { value: await pin.exercise(record) };
    } catch (error) {
      outcome = {
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      };
    }
    expect(normalized({ calls, outcome })).toMatchSnapshot();
  });
}
