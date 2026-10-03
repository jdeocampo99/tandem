import type { ModelRecord } from "../contract.ts";

/** The pseudo-provider whose selectors, `claude-code/<model>`, run their role in Claude Code. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** The models a role can name to run in Claude Code, with the thinking levels each accepts. */
export const CLAUDE_CODE_MODELS: readonly ModelRecord[] = [
  {
    selector: `${CLAUDE_CODE_PROVIDER}/opus`,
    id: "opus",
    provider: CLAUDE_CODE_PROVIDER,
    thinking: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    selector: `${CLAUDE_CODE_PROVIDER}/sonnet`,
    id: "sonnet",
    provider: CLAUDE_CODE_PROVIDER,
    thinking: ["low", "medium", "high", "max"],
  },
  {
    selector: `${CLAUDE_CODE_PROVIDER}/haiku`,
    id: "haiku",
    provider: CLAUDE_CODE_PROVIDER,
    thinking: ["off"],
  },
];
