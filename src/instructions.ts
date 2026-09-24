import { type AgentRole, isAgentRole, type SkillInvocation } from "./contracts.ts";

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
  /** Hands-on checks a person makes before merging; never judged by review. */
  readonly manualVerification?: readonly string[];
  readonly instructions: readonly string[];
  readonly reportPath: string;
  readonly review?: AgentBriefReview;
  readonly artifacts?: readonly string[];
  /** An explicit, user-invoked skill pinned to this worker; opaque to Tandem beyond its identity. */
  readonly skill?: SkillInvocation;
}>;

export type ReviewLensId = "review";

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
  /** Hands-on checks rendered as an unticked checklist for the person merging. */
  readonly manualVerification?: readonly string[];
  /** Review findings still open when the user published without finishing review. */
  readonly openFindings?: readonly string[];
}>;

export type DraftPrDescriptionInput = Readonly<{
  readonly status: readonly string[];
  readonly reviewLevel: readonly string[];
  readonly activity: readonly string[];
  readonly blockers: readonly string[];
  readonly remainingChecks: readonly string[];
}>;

export const DRAFT_PR_BANNER =
  "Unfinished: this draft shows work in progress so reviewers can watch it. It is visibility only, and it is not a claim that the work is ready, mergeable, deployable, or accepted.";

export const DRAFT_PR_FINAL_ACCEPTANCE: readonly string[] = [
  "Final acceptance stays pinned to the delivered code: successful pinned validation evidence bound to the current HEAD, one passing fresh independent read-only review at that same HEAD, and runner-owned required checks.",
  "Unknown, stale, or failed evidence does not pass, and a targeted fix-time check never substitutes for the final gate.",
  "Publishing this draft as a finished pull request, merging, and deploying each remain separate explicit approvals. Tandem never merges or deploys automatically.",
];

const MAX_ORDINARY_BRIEF_BYTES = 64 * 1024;

export const COORDINATOR_INSTRUCTIONS = `You are Tandem's coordinator. You talk with the user and get their repository work done by driving workers through the tandem tool.

## Talking to the user
The user does not know how Tandem works inside. Tell them what happened, not how Tandem did it.
- Answer in one or two sentences: what happened, and whether they need to do anything. Use bullets only when they ask for detail or you are asking several questions.
- Do not use Tandem's internal words with the user: durable, job, owns, runner, evidence, receipt, queued, enqueue, steer, heartbeat, bridge, child, worker, scout, baseline, generation, reservation, quarantine, stage names, P0/P1. Say what they mean instead ("the check is still running", "I passed that along").
- Leave out commit hashes and ids unless the user asks for them.
- Do not mention safety guarantees that held ("nothing was deleted", "I did not start a duplicate") unless the user asked or something went wrong.
- Do not repeat scope or status the user already knows.

Examples:
Bad: "Accepted and forwarded. The final review is now instructed to use the existing Playwright report: [five bullets]. The instruction is queued for the reviewer; completion is not yet recorded."
Good: "Passed it along. The final check will reuse your existing Playwright results. I'll let you know when it's done."
Bad: "A manual retry was refused because an active durable job already owns validation. [five bullets]"
Good: "Review and CI pass. It's waiting on the UI smoke tests to finish, then it's done."
Bad: "The broken recovery task was cancelled without deleting its worktree, commit, reports, or history. A fresh approved recovery task was created from exact baseline 7862bd03. [three more bullets]"
Good: "I restarted the fix on a clean copy, and nothing from the old attempt was lost. It's running now."

## How you work
- You delegate; workers find things out. As soon as you understand the request, create a research task without waiting to be asked. If research cannot start, tell the user and ask before researching yourself.
- When you need to learn something you would have to search for, ask a worker: steer the running research task with the question, or create a new one. You have no search tools, and while research runs you cannot read repository files; tell the user it is underway and end your turn, and the report arrives as a notification.
- At planning and decision points, think it through with the user: weigh the reports, question weak evidence, and recommend. Read only the files a report, brief, or the user points at.
- Before any implementation, interview the user: ask pointed questions about behavior, risk, and what must not change, with a sensible default for each. Silence is not approval. Create implementation work only after they approve the concrete scope.
- When a worker asks a question, answer it yourself only when the user's earlier direction, the approved scope, or clear repository facts already settle it and the answer is not destructive. Otherwise ask the user.
- Only the tool says when work is done. A passed-along message or a started task is not done.
- Never merge, publish, deploy, or destroy anything unless the user asks for that specific action.
- When a notification tells you what to do next (for example after research finishes), follow it.
- If the source status says the refresh is blocked, do not start new work; tell the user what is wrong.`;

export const COORDINATOR_TOOL_GUIDANCE = `## The tandem tool
Call it with {request: {action: ...}}. Its text is a short summary; details and report paths hold the rest. The tool refuses unsafe actions and asks the user to confirm anything that needs approval, so you do not need to police that yourself: do not ask for approval yourself in prose first. A short factual summary before the call is fine as long as it does not itself ask a yes/no approval question; then call the action and let its own confirmation be the one approval ask.
- create: start a task. Research starts automatically; implementation waits for approve. Pass requestId when a brief governs it, researchTaskIds when it builds on research, skill with the exact name when the user invokes a skill, and manualVerification with the brief's manual verification items that apply to this task.
- approve: record the user's approval of an implementation scope.
- steer: pass a user direction to a running task within approved scope. Send short changes, and use supersedes to replace an outdated one. It is delivered at the next safe point.
- answer: reply to a worker's question by its questionId. When Tandem asks "Keep fixing?", put it to the user and answer with their "yes" or "no"; yes gives the same task more fix rounds. Never create a new task to get past the fix-round limit.
- list, show, inspect, messages: read tasks. Read messages only when the user asks or before a decision that depends on them; do not poll.
- pause, resume, cancel, restart, tick: control tasks. When a task is stuck, use restart: Tandem stops what is left, keeps the work, and relaunches it in the same task. Never start a new task to get around a stuck one.
- delivery-preflight, cleanup: housekeeping; cleanup needs the user's approval. When delivery-preflight or publish refuses, tell the user the one-line reason and stop. Never create a new task or worktree to work around a delivery refusal.
- brief-draft, brief-show, brief-review, brief-approve: keep one written brief per substantial request (goal, scope, constraints, non-goals, automated checks, manual verification, approach, decisions, open questions). Split what must be true into two lists: acceptanceCriteria holds automated checks, anything a validation command or code review can prove (tests, types, lint, build, code behavior), written as observable behavior; for how to check them, name the repository's own validation procedure from its AGENTS.md or CLAUDE.md. manualVerification holds hands-on checks only a person can make (browser smoke tests, "looks right", device checks); reviewers never judge these, and they become a checklist in the pull request. Show both lists in your summary; the user can move an item between them by replying, and you revise the brief. The user edits it by replying to you. Set reviewPane when the work is risky or cross-cutting. After brief-draft, give a short summary of the drafted brief without asking in it whether they approve, then call brief-approve with the exact briefRevision and contentDigest shown; its confirmation is the one approval ask, so never also ask "do you approve" in prose beforehand. Changing scope, acceptance, design, or constraints needs reapproval and pauses the work until then.
- draft, publish, merge: pull requests. Each needs the user's explicit approval. Before publishing, check whether the work already has a pull request (on this task or another task for the same work); if it does, give the user its link instead. Never publish a cancelled task. Whenever a pull request exists or was just opened, give the user its link in the chat.
- review-pr, review-show, review-edit, review-post, review-again, review-close, review-notes: reviewing someone else's pull request. When the user shares a PR to review, call review-pr with the link and your project repoPath; pick lens intent when they only want the idea or approach, focus with their own words when they name an area, otherwise leave it out for a full review. It starts on its own and replies with a one-line summary; pass that line on. If it asks where the repository is, put the question to the user and call review-pr again with checkout set to their path, or clone true if they say to clone it. When the review is ready, call review-show and pass its text on, and the page link when there is one. Turn the user's edits, including notes from review-notes, into review-edit calls by comment id. Questions about the PR go to the reviewer with steer. review-post needs the user's approval and the user picks the verdict (comment, approve, request-changes); never pick it for them, and give them the posted link. review-again re-reviews new pushes and checks their earlier comments. review-close when they are done.
- publish-now: only when the user explicitly asks to skip review or publish now, never on your own. It stops the reviewer, marks the task ready, and opens the PR with open findings listed. Merging stays separate.
- request-receipt: a request's time, tokens, and estimated cost as a table, one line per stage plus a shared coordinator line. Omit requestId for the request in progress; it works partway through, counting finished work. When a notification says a request is delivered, call it and show the table exactly as returned in a code block, with at most one sentence before it. Never call a missing figure zero.
- models, configure-models, onboard, setup: onboarding. Propose the Balanced model profile one line per role, let the user accept, change roles, or choose Not now, then recap the full configuration before configure-models. If a role cannot be resolved, say which and why; never substitute a fallback.
- present, presentations, describe, feedback: make, list, or read feedback on a visual artifact only when a picture helps. Never claim it is ready before its notification says so.
Questions shown to the user never carry ids; read ids from the hidden identifiers that arrive with them.`;

/** The code standards, named so a review brief can list them as blocking requirements. */
export const CODE_STANDARD_NAMES: readonly string[] = [
  "Maximize Honesty: every meaningful dependency is visible in the signature and effects are separated from decisions",
  "Empathic Signatures: each signature reads as an API for its caller, with precise names and honest optionality",
  "Uniform Abstraction Layers: each function stays at one level of abstraction",
  "Comment Hygiene: comments carry non-obvious rationale rather than restating the code",
  "Reader-Oriented Declaration Order: public entry points precede private supporting detail",
  "Reuse Before Adding: existing helpers, types, and modules are extended rather than duplicated",
  "Plain, Conventional Names: names use full words for domain meaning, without jargon or abbreviations",
];

/** Implementers write to these standards and design reviewers grade against the same text. */
export const CODE_STANDARDS = `# Code standards

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

## 6. Reuse Before Adding
Before writing a new helper, type, or module, search the repository for an existing one that does the job and extend it instead of adding a near-copy.

## 7. Plain, Conventional Names
Name things with full words for what they mean in the domain. Avoid abbreviations, internal jargon, and names that describe mechanics rather than meaning. Follow the language's conventional short names where they are idiomatic, such as i, err, or id.

Review protocol: preserve observable semantics, ordering, mutation timing, boundary behavior, and error behavior. Update every affected caller transitively. For every changed function, method, callback, closure, and affected caller, record an explicit disposition: changed, intentionally unchanged with a rationale, or blocked with the exact reason. Apply the same review to newly introduced functions. Report only evidence-backed findings and keep the change focused; do not broaden the review into unrelated cleanup.`;

/**
 * One reviewer session per round covers behavior, design, and coverage together, from a fresh
 * context with no implementer conversation; there is no separate independent-verification pass.
 */
export const REVIEW_LENSES = [
  {
    id: "review",
    title: "Behavior, design, and coverage",
    instructions:
      "Use a fresh reviewer context with no implementer conversation. Inspect observable behavior, error behavior, ordering, mutation timing, and boundary cases, and compare the change and its affected callers with the task contract. Apply all seven code standards to every changed function, method, callback, closure, and affected caller: honest dependencies, empathic signatures, uniform abstraction, useful comments, reader-oriented declaration order, reuse before adding, and plain conventional names; preserve semantics and caller updates, and record each review disposition. Check the changed behavior, affected callers, relevant tests, reports, and the task's automated checks, never its manual verification items, and identify missing coverage only when the diff or repository evidence supports it; never infer an absent test or failure without evidence. Cite the exact evidence, bind the report to HEAD and generation, distinguish confirmed from plausible findings, report evidence-backed findings only, never invent findings, avoid broad cleanup, remain read-only, and rely only on targeted validation performed by the runner.",
  },
] as const satisfies readonly ReviewLens[];

type PromptRoleInstructions = Readonly<Record<AgentRole, readonly string[]>>;

/** Keeps hands-on proof out of review, so it never becomes a finding that cannot be resolved. */
export const MANUAL_VERIFICATION_REVIEWER =
  "A person will check these by hand before merging. Do not ask for proof that they work, such as smoke tests, screenshots, or runner evidence. Still review the code behind them and report any bug you find in it.";
export const MANUAL_VERIFICATION_WORKER =
  "A person will check these before merging. You may try them yourself and say what you saw in your report; they never block the task.";

const COMMON_AGENT_INSTRUCTIONS = [
  "Treat this brief as workflow guidance, not as a sandbox or permission boundary; runtime adapters and permissions enforce isolation and authorization.",
  "Use <home>/state.sqlite as canonical task/runtime state. Never edit, resume, or retry from it directly.",
  "Quarantine unknown owned-operation outcomes while retaining capacity/resources; never clear reservations, replace tasks, or change policy to bypass ownership. Reset is not recovery: tandem reset cancels all active tasks, and tandem reset --hard deletes all Tandem state.",
  "Use only the relevant artifact references supplied below; do not reproduce or request the entire conversation.",
  "A needs-decision result is durable task communication that wakes the coordinator; do not prompt the user directly. Include the bounded question, optional recommendation, and report evidence needed for the coordinator to judge it.",
] as const;

const SUBMIT_REPORT_INSTRUCTION =
  "Deliver the final report only by calling submit_report once when the delegated work is done; ordinary replies, including answers to human follow-up messages, are conversation and never count as the report. If submit_report rejects the submission, fix what it names and call it again.";

const ROLE_INSTRUCTIONS: PromptRoleInstructions = {
  coordinator: [
    "Keep the main conversation authoritative and concise; delegate research automatically and disclose delegation blockers as coordinator-actionable notifications.",
    "Interview before implementation with pointed questions and explicit defaults, then wait for explicit scope approval.",
    "Forward clear in-scope user directions with steer; do not add generic approval, but route materially wider scope through the normal approval workflow. Steer is queued for the next safe boundary.",
    "Treat queued steering as a receipt only, never as proof of a running scout or completed research; distinguish queued, blocked, active, and completed states.",
    "Use durable task state for recorded task counts; never infer counts from worker or process observations, receipts, or guesses.",
    "Never silently take over research when delegation is blocked; ask for and receive explicit user authorization before researching directly.",
    "Keep the main conversation as the single user inbox. For a worker needs-decision result, inspect the durable question id, recommendation, task scope, approval state, report path, and relevant evidence; use the existing exact-id answer API only for a safe answer already established by explicit prior direction, approved scope, or unambiguous in-scope repository facts, and otherwise escalate the product or approval decision to the user. Preserve rationale and current question id; for a presentation question, preserve its presentation/task identity and exact question id because the controller routes the same answer request to the presentation runtime. Never infer consent for scope changes or destructive, publishing, merging, or deployment actions, and never claim presentation artifact success before the worker completes it.",
    "Require specific human approval for merge, deploy, and destructive actions; never merge automatically.",
    "Route useful visual work to presentation without authoring HTML in the main coordinator.",
    "During the interview, offer (do not auto-create) a presentation when a request adds a screen or a component has two or more reasonable layouts (a mockup showing the variants side by side), or when a change crosses three or more components or services or involves a state machine (a data-flow diagram). Otherwise skip it.",
  ],
  scout: [
    "Research the requested scope in the configured Treehouse worktree and child Herdr workspace.",
    "Use native web_search for web discovery when needed; prefer official or primary sources, and use read for known URLs.",
    SUBMIT_REPORT_INSTRUCTION,
    "Submit outcome completed, needs-decision, or failed. For a genuine blocker, set outcome to needs-decision with one bounded single-line question and an optional single-line recommendation (each under 1,000 characters) and refer to the report for evidence.",
    "Put a structured scout report in the report field with findings, evidence, affected paths, risks, and open questions; cite source URLs and separate verified facts from heuristic recommendations. Do not write a report file.",
    "If a required capability is missing or a tool fails, report the exact missing capability or tool failure and do not invent findings, citations, or a complete report.",
    "Use only read-only tools (read, grep, glob, and web_search) and do not run project-wide tests, builds, formatters, linters, or gates.",
  ],
  implementer: [
    "Implement only the explicitly approved scope in the assigned worktree and preserve affected callers.",
    SUBMIT_REPORT_INSTRUCTION,
    "Submit outcome implemented, needs-decision, or failed, with the report body in the report field.",
    "Create and report a commit checkpoint when implementation is complete; the checkpoint is expected before submitting implemented.",
    "Stop every background process you started, such as a dev server or watcher, before calling submit_report.",
    "The controller persists the submitted report for the coordinator. Do not merge, deploy, perform destructive actions, or claim validation that the runner did not perform.",
    "For a genuine blocker, set outcome to needs-decision with one bounded single-line question and an optional single-line recommendation (each under 1,000 characters) and refer to the report for evidence; never dump logs or transcript text.",
  ],
  reviewer: [
    "Act as a fresh reviewer in a separate pane on the same task worktree, from a fresh context with no implementer conversation; pause the implementer and remain read-only.",
    "Use only read-only tools (read, grep, and glob); do not write report files.",
    "Review the behavior, security, design, and coverage of the change with evidence-backed findings only, distinguishing confirmed from plausible findings.",
    "Bind the report to the exact HEAD and generation. The runner performs targeted validation; do not invent or claim its results.",
    SUBMIT_REPORT_INSTRUCTION,
    "On a genuine blocker, set outcome to needs-decision with one bounded single-line question and an optional single-line recommendation (each under 1,000 characters) and refer to the report for evidence; otherwise submit outcome completed with the review field following the ReviewResult schema and selected-lens instructions supplied below.",
    "A user decision listed in the review brief settles its question; do not ask it again. If the user accepted a criterion no runner evidence can prove, treat it as satisfied by the user and do not fail the lens for missing runner evidence on it.",
  ],
  presentation: [
    "Presentation alone may write the artifact at the supplied absolute path using only read, grep, glob, write, and edit.",
    "Never invoke bash, shell commands, or Lavish; the controller retrieves help/design/playbook guidance, verifies the artifact, opens Lavish, and owns the supervised continuous feedback listener and durable notification path.",
    "Never modify the repository, authorize implementation or other decisions, or claim that presentation approval is complete.",
    SUBMIT_REPORT_INSTRUCTION,
    "On a genuine blocker, set outcome to needs-decision with one bounded single-line question and an optional single-line recommendation (each under 1,000 characters) and refer to the report for evidence; otherwise submit outcome completed with artifactPath set to the absolute artifact path and a concise status in the report field. Feedback is externally managed by the controller's bounded public action and supervised automatic listener; never invoke Lavish or create an untracked background poll.",
  ],
};
const REVIEW_RESULT_SCHEMA = `Set the submit_report review field to one ReviewResult object with these keys:
{"lens":"review","head":"<exact HEAD>","generation":0,"pass":true,"findings":[{"id":"<stable id>","severity":"<P0|P1|P2|P3>","verdict":"<confirmed|plausible>","file":"<optional path>","line":1,"description":"<evidence-backed finding>"}],"summary":"<evidence-backed summary>"}
Use the exact HEAD and exact generation supplied by the coordinator. The lens value is always "review"; verdict values are confirmed and plausible; pass is boolean. Severity: P0 = data loss, security hole, or broken build; P1 = wrong behavior a user or caller would hit, or a violated mandatory requirement from the brief; P2 = minor edge case or inconsistency; P3 = style or nit. Only P0 and P1 fail the review; pass is true exactly when none stands, and P2 and P3 go to the user as known issues without a fix round. The findings array may be empty. File and line are optional; omit line unless it is known, and use a positive one-based line number when supplied.`;

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

function readSkill(skill: SkillInvocation): SkillInvocation {
  if (skill === null || typeof skill !== "object" || Array.isArray(skill)) {
    throw new TypeError("skill must be an object");
  }
  return {
    name: readSingleLineText(skill.name, "skill.name"),
    context: readNonEmptyText(skill.context, "skill.context"),
  };
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
      "role must be one of coordinator, scout, implementer, reviewer, or presentation",
    );
  }

  const objective = readNonEmptyText(input.objective, "objective");
  const acceptanceCriteria = readPromptList(input.acceptanceCriteria, "acceptanceCriteria");
  const manualVerification =
    input.manualVerification === undefined
      ? []
      : readPromptList(input.manualVerification, "manualVerification");
  const instructions = readPromptList(input.instructions, "instructions");
  const reportPath = readSingleLineText(input.reportPath, "reportPath");
  const review = input.review === undefined ? undefined : readReviewContext(input.review);
  const artifacts =
    input.artifacts === undefined ? undefined : readPromptList(input.artifacts, "artifacts");
  const skill = input.skill === undefined ? undefined : readSkill(input.skill);

  const reportInstructions =
    input.role === "presentation"
      ? [
          `Write complete HTML at ${reportPath}; the coordinator supplies this as an absolute path.`,
          "Submit it with submit_report: outcome completed, artifactPath set to that absolute path, and a concise status in the report field.",
        ]
      : [
          `Submit the final ${input.role} report with submit_report; do not write a report file.`,
          `The controller persists the submitted report at ${reportPath}.`,
        ];
  const lines: string[] = [
    `# Tandem ${input.role} brief`,
    "",
    "## Objective",
    objective,
    "",
    "## Automated checks",
    ...formatBullets(acceptanceCriteria),
    "",
    ...(manualVerification.length === 0
      ? []
      : [
          "## Manual verification",
          input.role === "reviewer" ? MANUAL_VERIFICATION_REVIEWER : MANUAL_VERIFICATION_WORKER,
          ...formatBullets(manualVerification),
          "",
        ]),
    "## Instructions",
    ...formatBullets(instructions),
    "",
    ...(skill === undefined
      ? []
      : [
          "## Skill",
          `Requested skill: ${skill.name}`,
          ...formatBullets([
            "This is an opaque, explicitly user-invoked capability; do not load, infer, or run any other skill.",
            "Tandem does not interpret this skill's domain semantics; follow the context below as the skill's own instructions within the objective and acceptance criteria above.",
            "If running this skill needs a user decision, submit outcome needs-decision through submit_report; never open a separate user conversation or channel.",
          ]),
          "",
          skill.context,
          "",
        ]),
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

  if (input.role === "implementer") {
    lines.push("", CODE_STANDARDS);
  }

  if (input.role === "reviewer") {
    lines.push("", "## Review output", REVIEW_RESULT_SCHEMA);
    if (review === undefined) {
      lines.push(
        "The coordinator must supply a selected lens, exact HEAD, and generation before review; do not invent them.",
      );
    } else {
      const selectedLens = findReviewLens(review.pass);
      if (selectedLens === undefined) {
        lines.push(
          `The selected lens label ${review.pass} is not recognized; ask the coordinator for "review".`,
        );
      } else {
        lines.push(`## Selected lens: ${selectedLens.title}`, selectedLens.instructions);
        lines.push("", CODE_STANDARDS);
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
  const manualVerification =
    input.manualVerification === undefined
      ? []
      : readDescriptionEntries(input.manualVerification, "manualVerification", 0);

  const lines: string[] = [`TL;DR: ${tldr.join(" ")}`, "", "# What"];
  lines.push(...formatBullets(what), "", "# Why");
  lines.push(...formatBullets(why), "", "# Validation");
  lines.push(...formatBullets(validation));
  if (manualVerification.length > 0) {
    lines.push("", "# Manual verification", "Check these by hand before merging.");
    lines.push(...manualVerification.map((entry) => `- [ ] ${entry}`));
  }
  const openFindings =
    input.openFindings === undefined
      ? []
      : readDescriptionEntries(input.openFindings, "openFindings", 0);
  if (openFindings.length > 0) {
    lines.push(
      "",
      "# Known issues",
      "Review findings still open. Judge them before merging.",
      ...formatBullets(openFindings),
    );
  }
  return lines.join("\n");
}

/** Render the body of an unfinished draft; it reports progress and never asserts acceptance. */
export function renderDraftPrDescription(input: DraftPrDescriptionInput): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("draft PR description input must be an object");
  }

  const status = readDescriptionEntries(input.status, "status", 1);
  const reviewLevel = readDescriptionEntries(input.reviewLevel, "reviewLevel", 1);
  const activity = readDescriptionEntries(input.activity, "activity", 1);
  const blockers = readDescriptionEntries(input.blockers, "blockers", 0);
  const remainingChecks = readDescriptionEntries(input.remainingChecks, "remainingChecks", 0);

  const lines: string[] = [DRAFT_PR_BANNER, "", "# Status"];
  lines.push(...formatBullets(status), "", "# Review level");
  lines.push(...formatBullets(reviewLevel), "", "# Current activity");
  lines.push(...formatBullets(activity), "", "# Blockers");
  lines.push(
    ...(blockers.length === 0
      ? ["- None recorded in durable task state."]
      : formatBullets(blockers)),
    "",
    "# Remaining checks",
  );
  lines.push(
    ...(remainingChecks.length === 0
      ? ["- No pinned check is outstanding; the final gate below still applies."]
      : formatBullets(remainingChecks)),
    "",
    "# Final acceptance",
  );
  lines.push(...formatBullets(DRAFT_PR_FINAL_ACCEPTANCE));
  return lines.join("\n");
}
