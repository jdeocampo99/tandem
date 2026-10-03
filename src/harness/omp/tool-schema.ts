import type { TJsonSchema } from "@oh-my-pi/pi-ai";
import { z } from "zod/v4";

/** The plain JSON Schema OMP's `registerTool` accepts as `parameters` for a zod tool schema. */
export function ompToolParameters(schema: z.ZodType): TJsonSchema {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema, { io: "input" });
  return parameters;
}
