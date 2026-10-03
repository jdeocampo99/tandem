import { z } from "zod/v4";
import {
  COPY_ASSET_DESCRIPTION,
  copyAssetSchema,
  SUBMIT_REPORT_DESCRIPTION,
  submitReportSchema,
  TANDEM_TOOL_DESCRIPTION,
  tandemRequestSchema,
} from "../../session/tools.ts";
import type { WorkerRole } from "../../workers/jobs.ts";
import { COPY_ASSET_TOOL, SUBMIT_REPORT_TOOL } from "../../workers/terminal.ts";
import type { WireToolSpec } from "./plugins/tandem/hooks/protocol.ts";

/**
 * A tool as `$.tool.register` takes it, from the zod schema the sidecar parses its input with. The
 * sidecar lists these on its ready line, because a mod cannot import zod or anything outside its
 * plugin.
 */
function wireToolSpec(name: string, description: string, schema: z.ZodType): WireToolSpec {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
  return { name, description, inputSchema };
}

export const TANDEM_TOOL = "tandem";

export function coordinatorTools(): readonly WireToolSpec[] {
  return [wireToolSpec(TANDEM_TOOL, TANDEM_TOOL_DESCRIPTION, tandemRequestSchema)];
}

/** `submit_report` with the role's report schema, and `copy_asset` for a scout's mockups. */
export function workerTools(role: WorkerRole): readonly WireToolSpec[] {
  const report = wireToolSpec(
    SUBMIT_REPORT_TOOL,
    SUBMIT_REPORT_DESCRIPTION,
    submitReportSchema(role),
  );
  return role === "scout"
    ? [report, wireToolSpec(COPY_ASSET_TOOL, COPY_ASSET_DESCRIPTION, copyAssetSchema)]
    : [report];
}
