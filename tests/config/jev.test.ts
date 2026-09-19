import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJevEnvironment, readJevRoutingCandidates } from "../../src/config/jev.ts";

test("uses shadow timeout defaults and bounds", () => {
  expect(readJevEnvironment({ TANDEM_JEV_MODE: "shadow", TYPESAFE_API_KEY: "fake" })).toMatchObject(
    {
      mode: "shadow",
      timeoutMs: 2_000,
      model: "jev-1.13.0",
    },
  );
  expect(() =>
    readJevEnvironment({
      TANDEM_JEV_MODE: "shadow",
      TYPESAFE_API_KEY: "fake",
      TANDEM_JEV_TIMEOUT_MS: "10001",
    }),
  ).toThrow();
});

test("allows 63 role candidates but rejects coordinator candidates", async () => {
  const home = await mkdtemp(join(tmpdir(), "tandem-jev-config-"));
  try {
    const candidates = Array.from({ length: 63 }, (_, index) => ({
      id: `candidate-${index}`,
      model: "provider/model",
      thinking: "medium",
      description: "bounded candidate",
    }));
    await writeFile(
      join(home, "jev.json"),
      JSON.stringify({ schemaVersion: 1, routingCandidates: { implementer: candidates } }),
    );
    expect((await readJevRoutingCandidates(home)).implementer).toHaveLength(63);
    await writeFile(
      join(home, "jev.json"),
      JSON.stringify({ schemaVersion: 1, routingCandidates: { coordinator: [] } }),
    );
    await expect(readJevRoutingCandidates(home)).rejects.toThrow(/coordinator/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
