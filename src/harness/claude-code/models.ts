import type { ModelRecord } from "../contract.ts";

/** The pseudo-provider whose selectors, `claude-code/<model>`, run their role in Claude Code. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Every `--effort` value Claude Code 2.1.288 accepts. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The `--model` aliases a role can name to run in Claude Code, with the levels each accepts.
 * Levels follow https://code.claude.com/docs/en/model-config.md: on the Anthropic API the aliases
 * resolve to Fable 5.1, Opus 5.5, and Sonnet 5.5, which take every effort level, and Haiku takes
 * none, so it runs without `--effort`.
 */
export const CLAUDE_CODE_MODELS: readonly ModelRecord[] = [
  { alias: "fable", thinking: EFFORT_LEVELS },
  { alias: "opus", thinking: EFFORT_LEVELS },
  { alias: "sonnet", thinking: EFFORT_LEVELS },
  { alias: "haiku", thinking: ["off"] as const },
].map(({ alias, thinking }) => ({
  selector: `${CLAUDE_CODE_PROVIDER}/${alias}`,
  id: alias,
  provider: CLAUDE_CODE_PROVIDER,
  thinking,
}));
