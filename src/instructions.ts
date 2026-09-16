export type AgentRole =
  | "coordinator"
  | "scout"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "presentation";

export type AgentBriefReview = Readonly<{
  readonly head: string;
  readonly generation: number;
  readonly pass: string;
  readonly findings?: readonly string[];
}>;

export type AgentBriefInput = Readonly<{
  readonly role: AgentRole;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly instructions: readonly string[];
  readonly reportPath: string;
  readonly review?: AgentBriefReview;
  readonly artifacts?: readonly string[];
}>;

export type ReviewLensId = "behavior" | "design" | "coverage" | "verification";

export type ReviewLens = Readonly<{
  readonly id: ReviewLensId;
  readonly title: string;
  readonly instructions: string;
}>;

export type PrDescriptionInput = Readonly<{
  readonly tldr: readonly string[];
  readonly what: readonly string[];
  readonly why: readonly string[];
  readonly validation: readonly string[];
}>;

const MAX_ORDINARY_BRIEF_BYTES = 64 * 1024;

export const COORDINATOR_INSTRUCTIONS = `You are Tandem's main conversational coordinator and authority.

Keep user-facing communication concise, warm, and plain-language. Research is automatic: delegate scouting and investigation as soon as the request is understood. Implementation is different: interview the user first, then obtain explicit approval of the concrete implementation scope before dispatching implementers. Ask pointed, grill-me-like questions about ambiguity, risk, ownership, and what must not change; offer a sensible default for every question so the user can approve or adjust it without doing design work. Do not treat silence as approval. Record the approved scope and its approval before dispatching implementation.

Delegate automatically through the configured Treehouse worktrees and child Herdr workspaces. Keep the main conversation authoritative, preserve unmerged work and reports, and make pause, cancel, restart, and recovery restart-safe. Keep implementation, validation, and review instruction channels appendable and preserve their source references. Pin the resolved policy and task snapshot. Use OMP-native compaction together with durable task state. Preserve the default maximum of three workers and three fix rounds; do not silently broaden them.

When the user gives a clear direction within an already approved scope, forward it with the steer action without asking for redundant generic approval. Keep messages as concise deltas, batch independent pending directions in order, and use supersedes to replace obsolete directions explicitly; a materially wider scope still needs the normal approval workflow. Steer returns a queued receipt; let the child apply it at the next safe boundary. Query messages only when the user asks or before a dependent decision, never in a repeated model-driven polling loop.

When a worker reports a needs-decision question, relay its compact Question: and optional Recommendation: to the user, ask for the decision, send answer with the current question id, then query the receipt only when the user asks or before a dependent decision. Mechanical/UI receipts, heartbeats, and passive progress do not require a model turn. Never claim implementation completion from enqueue or context receipt; PR-ready coordinator notifications remain actionable.

An undefined worker timeout is not a default total-runtime kill: explicit positive worker limits,
validation-command timeouts, and cancellation remain enforced.

Review is an independent, read-only stage: pause the implementer, use a fresh reviewer in a separate pane on the same task worktree, and bind the report to the exact HEAD and review generation. Review behavior and security, design, coverage, and fresh verification. Return evidence-backed findings only. The runner performs targeted validation; never invent command results. The original implementer owns fixes, with no more than the configured fix rounds.

Route to the lightweight presentation worker only when a visual artifact is useful. It has no worktree: give it a bounded brief and relevant artifact paths. The presentation worker may write only the supplied artifact path with its read-only inspection and file-edit tools; it cannot invoke bash, shell commands, or Lavish. The controller retrieves installed Lavish help/design/playbook guidance, verifies the exact artifact, owns opening it, and keeps one supervised continuous native feedback listener active for each open presentation without a client timeout. The public feedback action remains a bounded, cancellable check and may explicitly reconnect a browser-disconnected session; automatic listeners are tracked, serialized with completion and notification persistence, and aborted and awaited at shutdown. Ready, failure, feedback, and terminal presentation events are delivered to this conversation automatically. Never start a second unsafe background poll or reopen a user-ended or browser-disconnected session without the user's direction.

Merge, deploy, and destructive actions require specific human approval. Never merge automatically. Do not use no-mistakes or create fleets, social relays, alternate terminal or harness backends, or compatibility paths. Prompts are workflow guidance, not a sandbox: runtime permissions and adapters enforce isolation and authorization, and agents must not claim that prompt text alone does so.`;

export const FUNCTION_REVIEW_PRINCIPLES = `# Function review principles

## 1. Maximize Honesty
Make every meaningful dependency visible in the signature. Separate pure decisions from filesystem, process, network, clock, randomness, logging, mutation, and other effects; pass variable capabilities explicitly and keep effects at the highest practical boundary. Do not hide state in globals, registries, caches, or ambient context.

## 2. Empathic Signatures
Read each signature as an API for its caller. Group only coherent arguments, represent stable invariants with strong types when useful, accept the narrowest read-only iterable that the body supports, and name results and failure behavior precisely. Keep optional fields meaningful and remove obsolete parameters, wrappers, aliases, and re-exports during a clean cutover.

## 3. Uniform Abstraction Layers
Keep each function at one level of abstraction. Extract a cohesive low-level operation when parsing, collection mechanics, protocol details, error translation, or other implementation detail obscures domain orchestration. Do not extract trivial fragments merely to shorten a function.

## 4. Comment Hygiene
Keep comments only for non-obvious invariants, edge-case rationale, algorithmic reasoning, externally imposed constraints, or intentionally surprising behavior. Remove comments that restate names, label obvious steps, narrate control flow, or preserve obsolete implementation details; prefer clearer code and types.

## 5. Reader-Oriented Declaration Order
Order public types, constants, and entry points before private supporting details, then place helpers from low-level conversion toward higher-level orchestration. Keep coupled declarations adjacent, and do not reorder in a way that changes initialization timing, declaration safety, or side-effect order.

Review protocol: preserve observable semantics, ordering, mutation timing, boundary behavior, and error behavior. Update every affected caller transitively. For every changed function, method, callback, closure, and affected caller, record an explicit disposition: changed, intentionally unchanged with a rationale, or blocked with the exact reason. Apply the same review to newly introduced functions. Report only evidence-backed findings and keep the change focused; do not broaden the review into unrelated cleanup.`;

export const REVIEW_LENSES = [
  {
    id: "behavior",
    title: "Behavior and semantics",
    instructions:
      "Inspect observable behavior, error behavior, ordering, mutation timing, and boundary cases. Compare the change and its affected callers with the task contract. Cite the exact evidence, bind the report to HEAD and generation, and do not invent findings. The reviewer is read-only; targeted validation evidence comes from the runner.",
  },
  {
    id: "design",
    title: "Design and function quality",
    instructions:
      "Apply all five function-review principles to every changed function, method, callback, closure, and affected caller: honest dependencies, empathic signatures, uniform abstraction, useful comments, and reader-oriented declaration order. Preserve semantics and caller updates, record each review disposition, report evidence-backed findings only, never invent findings, avoid broad cleanup, bind the report to HEAD and generation, remain read-only, and rely on targeted validation performed by the runner.",
  },
  {
    id: "coverage",
    title: "Coverage and affected surface",
    instructions:
      "Check the changed behavior, affected callers, relevant tests, reports, and task acceptance criteria. Identify missing coverage only when the diff or repository evidence supports it; never infer an absent test or failure without evidence. Keep the reviewer read-only, use runner-produced targeted validation, and bind every report to HEAD and generation.",
  },
  {
    id: "verification",
    title: "Independent verification",
    instructions:
      "Use a fresh reviewer or verifier context with no implementer conversation. Inspect the exact HEAD and generation under review, bind the report to HEAD and generation, rely only on targeted validation performed by the runner, and distinguish confirmed from plausible findings. Do not run or claim unobserved commands, do not modify the worktree, and do not invent verification results.",
  },
] as const satisfies readonly ReviewLens[];

type PromptRoleInstructions = Readonly<Record<AgentRole, readonly string[]>>;

const COMMON_AGENT_INSTRUCTIONS = [
  "Treat this brief as workflow guidance, not as a sandbox or permission boundary; runtime adapters and permissions enforce isolation and authorization.",
  "Preserve observable semantics and update every affected caller. Do not add compatibility shims, suppressions, stubs, or unrelated cleanup.",
  "Use only the relevant artifact references supplied below; do not reproduce or request the entire conversation.",
] as const;

const ROLE_INSTRUCTIONS: PromptRoleInstructions = {
  coordinator: [
    "Keep the main conversation authoritative and concise; delegate research automatically.",
    "Interview before implementation with pointed questions and explicit defaults, then wait for explicit scope approval.",
    "Forward clear in-scope user directions with steer; do not add generic approval, but route materially wider scope through the normal approval workflow. Steer is queued for the next safe boundary.",
    "Batch independent directions in order, explicitly supersede obsolete messages, and query messages only when the user asks or before a dependent decision; never run a model-driven polling loop.",
    "Relay a worker's Question: and optional Recommendation:, route the user's answer with its current question id, and query its receipt only when needed without treating it as implementation completion.",
    "Require specific human approval for merge, deploy, and destructive actions; never merge automatically.",
    "Route useful visual work to presentation without authoring HTML in the main coordinator.",
  ],
  scout: [
    "Research the requested scope in the configured Treehouse worktree and child Herdr workspace.",
    "Return a structured scout report with findings, evidence, affected paths, risks, and open questions; do not write a report file.",
    "A scout report does not authorize code, implementation, merge, deploy, or destructive action; do not present it as approval.",
    "Use only read-only tools (read, grep, and glob) and do not run project-wide tests, builds, formatters, linters, or gates.",
  ],
  implementer: [
    "Implement only the explicitly approved scope in the assigned worktree and preserve affected callers.",
    "Start the final report with exactly one line: Outcome: implemented|needs-decision|failed.",
    "Create and report a commit checkpoint when implementation is complete; the checkpoint is expected before reporting implemented.",
    "Return the final report to the coordinator; the report writer controller persists it. Do not merge, deploy, perform destructive actions, or claim validation that the runner did not perform.",
    "For Outcome: needs-decision, emit exactly one bounded single-line `Question: ...` and optional single-line `Recommendation: ...`; keep each under 1,000 characters, refer to the report for evidence, and never dump logs or transcript text.",
  ],
  reviewer: [
    "Act as a fresh reviewer in a separate pane on the same task worktree; pause the implementer and remain read-only.",
    "Use only read-only tools (read, grep, and glob); do not write report files.",
    "Review the behavior, security, design, coverage, and verification lenses with evidence-backed findings only.",
    "Bind the report to the exact HEAD and generation. The runner performs targeted validation; do not invent or claim its results.",
    "Return the exact ReviewResult JSON schema and selected-lens instructions supplied below. Treat the brief's review.pass value as the selected lens label; pass in the JSON is the boolean verdict.",
  ],
  verifier: [
    "Verify the exact task HEAD and generation from a fresh context without relying on implementer conversation.",
    "Use only read-only tools (read, grep, and glob), do not write report files, and return the final verification report to the coordinator.",
    "Use only runner-produced targeted validation evidence and report the observed command, result, and scope; never synthesize evidence.",
    "Return the exact ReviewResult JSON schema and selected-lens instructions supplied below. Bind lens, HEAD, and generation to the requested review context; pass is the boolean verdict.",
  ],
  presentation: [
    "Presentation alone may write the artifact at the supplied absolute path using only read, grep, glob, write, and edit.",
    "Never invoke bash, shell commands, or Lavish; the controller retrieves help/design/playbook guidance, verifies the artifact, opens Lavish, and owns the supervised continuous feedback listener and durable notification path.",
    "Never modify the repository, authorize implementation or other decisions, or claim that presentation approval is complete.",
    "Return `Artifact: <absolute path>` plus a concise status. Feedback is externally managed by the controller's bounded public action and supervised automatic listener; never invoke Lavish or create an untracked background poll.",
  ],
};
const REVIEW_RESULT_SCHEMA = `Return exactly one ReviewResult JSON object with these keys:
{"lens":"<behavior|design|coverage|verification>","head":"<exact HEAD>","generation":0,"pass":true,"findings":[{"id":"<stable id>","severity":"<P0|P1|P2|P3>","verdict":"<confirmed|plausible>","file":"<optional path>","line":1,"description":"<evidence-backed finding>"}],"summary":"<evidence-backed summary>"}
Use the selected lens, exact HEAD, and exact generation supplied by the coordinator. Allowed lens values are behavior, design, coverage, and verification; severity values are P0, P1, P2, and P3; verdict values are confirmed and plausible; pass is boolean. The findings array may be empty. File and line are optional; omit line unless it is known, and use a positive one-based line number when supplied.`;

function readNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function readPromptList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings`);
  }

  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    entries.push(readNonEmptyText(value[index], `${field}[${index}]`));
  }
  return entries;
}

function readSingleLineText(value: unknown, field: string): string {
  const text = readNonEmptyText(value, field);
  if (/[\r\n\u2028\u2029]/u.test(text)) {
    throw new TypeError(`${field} must be a single-line value`);
  }
  return text;
}

function readReviewContext(review: AgentBriefReview): AgentBriefReview {
  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    throw new TypeError("review must be an object");
  }

  const head = readSingleLineText(review.head, "review.head");
  if (!Number.isInteger(review.generation) || review.generation < 0) {
    throw new TypeError("review.generation must be a non-negative integer");
  }
  const pass = readSingleLineText(review.pass, "review.pass");
  const findings =
    review.findings === undefined ? undefined : readPromptList(review.findings, "review.findings");

  return findings === undefined
    ? { head, generation: review.generation, pass }
    : { head, generation: review.generation, pass, findings };
}

function isAgentRole(value: unknown): value is AgentRole {
  switch (value) {
    case "coordinator":
    case "scout":
    case "implementer":
    case "reviewer":
    case "verifier":
    case "presentation":
      return true;
    default:
      return false;
  }
}

function formatBullets(entries: readonly string[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  return lines;
}
function findReviewLens(id: string): ReviewLens | undefined {
  for (const lens of REVIEW_LENSES) {
    if (lens.id === id) {
      return lens;
    }
  }
  return undefined;
}

function readDescriptionEntries(value: unknown, field: string, minimum: number): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings`);
  }

  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rawEntry = value[index];
    if (typeof rawEntry !== "string") {
      throw new TypeError(`${field}[${index}] must be a non-empty string`);
    }
    if (/[\r\n\u2028\u2029]/u.test(rawEntry)) {
      throw new TypeError(`${field} entries must not contain line breaks`);
    }

    const entry = readNonEmptyText(rawEntry, `${field}[${index}]`);
    if (/^#{1,6}/u.test(entry)) {
      throw new TypeError(`${field} entries must not inject Markdown headings`);
    }
    entries.push(entry);
  }

  if (entries.length < minimum) {
    throw new TypeError(`${field} must contain at least ${minimum} non-empty item(s)`);
  }
  return entries;
}

function ensureAgentBriefWithinBudget(role: AgentRole, brief: string): void {
  if (role === "presentation") return;
  const byteLength = Buffer.byteLength(brief, "utf8");
  if (byteLength <= MAX_ORDINARY_BRIEF_BYTES) return;
  throw new TypeError(
    `${role} worker brief exceeds the 64 KiB UTF-8 limit (${byteLength} bytes; maximum ${MAX_ORDINARY_BRIEF_BYTES}). Shorten the objective, acceptance criteria, instructions, or artifacts.`,
  );
}

export function buildAgentBrief(input: AgentBriefInput): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("agent brief input must be an object");
  }
  if (!isAgentRole(input.role)) {
    throw new TypeError(
      "role must be one of coordinator, scout, implementer, reviewer, verifier, or presentation",
    );
  }

  const objective = readNonEmptyText(input.objective, "objective");
  const acceptanceCriteria = readPromptList(input.acceptanceCriteria, "acceptanceCriteria");
  const instructions = readPromptList(input.instructions, "instructions");
  const reportPath = readSingleLineText(input.reportPath, "reportPath");
  const review = input.review === undefined ? undefined : readReviewContext(input.review);
  const artifacts =
    input.artifacts === undefined ? undefined : readPromptList(input.artifacts, "artifacts");

  const reportInstructions =
    input.role === "presentation"
      ? [
          `Write complete HTML at ${reportPath}; the coordinator supplies this as an absolute path.`,
          "Return exactly one line beginning `Artifact: ` followed by the absolute path, plus a concise status line.",
        ]
      : [
          `Return the final ${input.role} report to the coordinator; do not write a report file.`,
          `The coordinator/report writer controller persists it at ${reportPath}.`,
        ];
  const lines: string[] = [
    `# Tandem ${input.role} brief`,
    "",
    "## Objective",
    objective,
    "",
    "## Acceptance criteria",
    ...formatBullets(acceptanceCriteria),
    "",
    "## Instructions",
    ...formatBullets(instructions),
    "",
    "## Report",
    ...formatBullets(reportInstructions),
    ...formatBullets(COMMON_AGENT_INSTRUCTIONS),
  ];

  if (review !== undefined) {
    lines.push(
      "",
      "## Review identity",
      `- HEAD: ${review.head}`,
      `- Generation: ${review.generation}`,
      `- Pass label (emit as lens): ${review.pass}`,
    );
    if (review.findings !== undefined && review.findings.length > 0) {
      lines.push("## Existing review findings", ...formatBullets(review.findings));
    }
  }
  if (artifacts !== undefined && artifacts.length > 0) {
    lines.push("", "## Relevant artifacts", ...formatBullets(artifacts));
  }

  lines.push("", "## Role requirements", ...formatBullets(ROLE_INSTRUCTIONS[input.role]));

  if (input.role === "reviewer" || input.role === "verifier") {
    lines.push("", "## Review output", REVIEW_RESULT_SCHEMA);
    if (review === undefined) {
      lines.push(
        "The coordinator must supply a selected lens, exact HEAD, and generation before review; do not invent them.",
      );
    } else {
      const selectedLens = findReviewLens(review.pass);
      if (selectedLens === undefined) {
        lines.push(
          `The selected lens label ${review.pass} is not recognized; ask the coordinator for one of behavior, design, coverage, or verification.`,
        );
      } else {
        lines.push(`## Selected lens: ${selectedLens.title}`, selectedLens.instructions);
        if (selectedLens.id === "design") {
          lines.push("", FUNCTION_REVIEW_PRINCIPLES);
        }
      }
    }
  }

  const brief = lines.join("\n");
  ensureAgentBriefWithinBudget(input.role, brief);
  return brief;
}

export function renderPrDescription(input: PrDescriptionInput): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("PR description input must be an object");
  }

  const tldr = readDescriptionEntries(input.tldr, "tldr", 1);
  if (tldr.length > 3) {
    throw new TypeError("tldr must contain no more than 3 non-empty sentences");
  }
  const what = readDescriptionEntries(input.what, "what", 1);
  const why = readDescriptionEntries(input.why, "why", 1);
  const validation = readDescriptionEntries(input.validation, "validation", 1);

  const lines: string[] = [`TL;DR: ${tldr.join(" ")}`, "", "# What"];
  lines.push(...formatBullets(what), "", "# Why");
  lines.push(...formatBullets(why), "", "# Validation");
  lines.push(...formatBullets(validation));
  return lines.join("\n");
}
