import { expect, test } from "bun:test";
import { TANDEM_TOOL } from "../../../src/harness/claude-code/plugins/tandem/hooks/tandem-tool.ts";
import { tandemToolSpec } from "../../../src/harness/claude-code/tandem-tool.ts";

// When this fails, run `bun src/harness/claude-code/tandem-tool.ts` to regenerate the mod's copy.
test("the mod registers the tandem tool the sidecar parses, with the OMP tool's description", () => {
  expect(tandemToolSpec()).toEqual(TANDEM_TOOL);
});
