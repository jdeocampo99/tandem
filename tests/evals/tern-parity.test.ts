import { test } from "bun:test";
import { luauBinary } from "../luau.ts";
import { inventory } from "./tern-parity/inventory.ts";
import { knownDivergence } from "./tern-parity/known-divergence.ts";

// The parity contract must never pass by skipping: a missing luau CLI fails here.
luauBinary();

for (const entry of inventory) test(`${entry.view} · ${entry.item}`, entry.run, 60_000);
for (const entry of knownDivergence) test(`finding 1: ${entry.name}`, entry.run, 60_000);
