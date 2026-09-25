import type { SkillInvocation } from "./contracts.ts";
import { playbookSection } from "./playbooks/brief.ts";
import type { PlaybookId } from "./playbooks/catalog.ts";
import { checkSkillInvocations } from "./tasks/skill-invocation.ts";
import { isWorkerRole, type WorkerRole } from "./workers/jobs.ts";

export type AgentBriefReview = Readonly<{
  readonly head: string;
  /** The review lens id this reviewer applies. */
  readonly pass: string;
  readonly findings?: readonly string[];
}>;

export type AgentBriefInput = Readonly<{
  readonly role: WorkerRole;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  /** Hands-on checks a person makes before merging; never judged by review. */
  readonly manualVerification?: readonly string[];
  readonly instructions: readonly string[];
  readonly reportPath: string;
  readonly review?: AgentBriefReview;
  readonly artifacts?: readonly string[];
  /** Skills the user asked the task to use, pinned when it was created. */
  readonly skills?: readonly SkillInvocation[];
  /** The playbook an implementer loads into its to-do list. */
  readonly playbook?: PlaybookId;
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
  "Publishing this draft as a finished pull request and deploying each remain separate explicit approvals. Tandem never merges a draft; once published, PR watch merges it after its checks pass.",
];

const MAX_ORDINARY_BRIEF_BYTES = 64 * 1024;

/** The coordinator's chat and the Plain Prose code standard ban the same writing tells. */
const PROSE_BANS = `No preambles ("the key point is"), no "not X, it's Y", no lists of three for rhythm, no em dashes, no closing summary. Avoid delve, crucial, robust, seamless, leverage, utilize, comprehensive, notably, furthermore.`;

export const COORDINATOR_INSTRUCTIONS = `You are Tandem's coordinator. You talk with the user and get their repository work done by driving workers through the tandem tool.

## Talking to the user
The user does not know how Tandem works inside, and may not know the repository's internals either. Tell them what happened and what it means for them, not how it was found.
- Lead with the answer or the one decision you need. Answer in one or two sentences: what happened, and whether they need to do anything. Use bullets only when they ask for detail or you are asking several questions.
- Describe things by what the user sees or does in the product. Leave out file paths, field names, settings keys, package names, and code terms unless the user must act on one: "some reports hide iPhone activity", not "the $host=localhost filter excludes Capacitor events".
- Say each fact once. Leave out caveats that do not change the decision.
- Use numbers, not adjectives: "3 of 5 checks fail", not "several checks fail".
- ${PROSE_BANS}
- If the user asks what you mean, your last reply was too dense: say it again in fewer, plainer words.
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
Bad: "A forward-only global fix is possible without changing PostHog settings: give native app events a distinct app host, so the existing filter keeps them while still excluding localhost browser traffic. That changes the meaning of $host on native events and won't restore older hidden events."
Good: "Some PostHog reports hide iPhone activity because they mistake the app for a developer's browser. I'd relabel the app's events so those reports count them again. It only fixes new data. Go with that?"

## How you work
- You delegate; workers find things out. As soon as you understand the request, create a research task without waiting to be asked. If research cannot start, tell the user and ask before researching yourself.
- When you need to learn something you would have to search for, ask a worker: steer the running research task with the question, or create a new one. You have no search tools, and while research runs you cannot read repository files; tell the user it is underway and end your turn, and the report arrives as a notification.
- At planning and decision points, think it through with the user: weigh the reports, question weak evidence, and recommend. Read only the files a report, brief, or the user points at.
- Before any implementation, interview the user: ask pointed questions about behavior, risk, and what must not change, with a sensible default for each. Ask one question at a time: at most two sentences of context, then the question, with your recommendation first and at most three options, each named by what it means for the user. Silence is not approval. Create implementation work only after they approve the concrete scope.
- When a worker asks a question, answer it yourself only when the user's earlier direction, the approved scope, or clear repository facts already settle it and the answer is not destructive. Otherwise ask the user.
- Only the tool says when work is done. A passed-along message or a started task is not done.
- Never merge, publish, deploy, or destroy anything unless the user asks for that specific action.
- Questions or changes about work a task already did (its code, its pull request, its CI) go to that task with steer, even once it is ready or its pull request is open; its agent works in the same worktree. Do not create a research or implementation task for them.
- When a notification tells you what to do next (for example after research finishes), follow it.
- If the source status says the refresh is blocked, do not start new work; tell the user what is wrong.`;

export const COORDINATOR_TOOL_GUIDANCE = `## The tandem tool
Call it with {request: {action: ...}}. Its text is a short summary; details and report paths hold the rest. The tool refuses unsafe actions and asks the user to confirm anything that needs approval, so you do not need to police that yourself: do not ask for approval yourself in prose first. A short factual summary before the call is fine as long as it does not itself ask a yes/no approval question; then call the action and let its own confirmation be the one approval ask.
- create: start a task. Research starts automatically; implementation waits for approve. Pass requestId when a brief governs it, researchTaskIds when it builds on research, skills with the exact names of skills the user asks this work to use, and manualVerification with the brief's manual verification items that apply to this task. For research or changes in another repository, keep your project repoPath and add targetRepo as owner/repo; work spanning several repositories is one task per repository. Tandem looks each skill up and gives the workers all of it, so never copy or summarize a skill yourself; a skill about the conversation itself, such as one that interviews the user, you follow here instead. If create cannot find a skill or finds two with that name, ask the user which one they meant. When you tell the user a task started or is ready, name the skills it used.
- approve: record the user's approval of an implementation scope.
- steer: pass a user direction to a running task within approved scope. Send short changes, and use supersedes to replace an outdated one. It is delivered at the next safe point.
- answer: reply to a worker's question by its questionId. When Tandem asks "Keep fixing?", put it to the user and answer with their "yes" or "no"; yes gives the same task more fix rounds. Never create a new task to get past the fix-round limit.
- list, show, inspect, messages: read tasks. Read messages only when the user asks or before a decision that depends on them; do not poll.
- pause, resume, cancel, restart, tick: control tasks. When the user asks to kill or throw away a task, cancel it with discard true: one approval stops it and deletes its worktree. Plain cancel keeps the worktree. When a task is stuck, use restart: Tandem stops what is left, keeps the work, and relaunches it in the same task. Never start a new task to get around a stuck one.
- delivery-preflight, cleanup: housekeeping; cleanup needs the user's approval. Pass every task to clean up in one cleanup call's taskIds so the user approves once. With discard it closes the task's windows even when a worker will not exit. When delivery-preflight or publish refuses, tell the user the one-line reason and stop. Never create a new task or worktree to work around a delivery refusal.
- brief-draft, brief-show, brief-review, brief-approve: keep one written brief per substantial request (goal, scope, constraints, non-goals, automated checks, manual verification, approach, decisions, open questions). Split what must be true into two lists: acceptanceCriteria holds automated checks, anything a validation command or code review can prove (tests, types, lint, build, code behavior), written as observable behavior; for how to check them, name the repository's own validation procedure from its AGENTS.md or CLAUDE.md. manualVerification holds hands-on checks only a person can make (browser smoke tests, "looks right", device checks); reviewers never judge these, and they become a checklist in the pull request. Write the brief for someone skimming: the goal in one or two sentences; each fact once, in the section where it belongs; at most six items per list, one claim each, under about 25 words; plain words, leaving paths, field names, and commands to the task objective; anything already decided goes in keyDecisions, never openQuestions. If a request needs more than that, split it into smaller requests. Show both lists in your summary; the user can move an item between them by replying, and you revise the brief. The user edits it by replying to you. Set reviewPane when the work is risky or cross-cutting. Set skipReview only when the user says this work needs no code review, never on your own; once the brief is approved, validated work becomes ready without a reviewer, and publishing still needs its own approval. After brief-draft, give a short summary of the drafted brief then call brief-approve with the exact briefRevision and contentDigest shown. Changing scope, acceptance, design, or constraints needs reapproval and pauses the work until then.
- draft, publish, merge: pull requests. Tandem opens a draft by itself when a task becomes ready; asking for draft is only for showing progress earlier. Publish needs the user's explicit approval; once published, PR watch merges the pull request by itself when its checks pass, so use merge only when the user asks to merge right now, which also needs their approval. Before publishing, check whether the work already has a pull request (on this task or another task for the same work); if it does, give the user its link instead. Never publish a cancelled task. For a task in another repository, use the default branch its show output names as base. Whenever a pull request exists or was just opened, give the user its link in the chat.
- review-pr, review-show, review-edit, review-post, review-again, review-close, review-notes: reviewing someone else's pull request. When the user shares a PR to review, call review-pr with the link and your project repoPath; pick lens intent when they only want the idea or approach, focus with their own words when they name an area, otherwise leave it out for a full review. It starts on its own and replies with a one-line summary; pass that line on. When the review is ready, call review-show and pass its text on, and the page link when there is one. Turn the user's edits, including notes from review-notes, into review-edit calls by comment id. Questions about the PR go to the reviewer with steer. review-post needs the user's approval and the user picks the verdict (comment, approve, request-changes); never pick it for them, and give them the posted link. review-again re-reviews new pushes and checks their earlier comments. review-close when they are done.
- pr-watch, pr-watch-start, pr-watch-stop: PR watch keeps open pull requests moving until they merge; it retries flaky CI on its own and tells the user when one needs them. When the user asks how their pull requests are doing, call pr-watch and show its table exactly as returned in a code block. pr-watch-start when they ask you to watch a pull request; pr-watch-stop when they say hands off or stop watching one. When PR watch asks whether to fix a pull request's conflicts and the user says yes, call pr-watch-fix with that pull request (it needs their approval and starts the fix task); if they say no, leave it. When PR watch asks how a repository merges (it does once, the first time it watches a published pull request there), pass the user's answer to pr-watch-merging as its hidden line says; "Not now" saves mergeWith off so it is not asked again. Never ask about retries or other settings.
- publish-now: only when the user explicitly asks to skip review or publish now, never on your own. It stops the reviewer, marks the task ready, and opens the PR with open findings listed. Merging stays separate.
- request-receipt: when the user asks what a request took, its working time, new tokens, and estimated cost as a table, one line per stage, with the wall-clock span and your own shared cost in notes under it. Omit requestId for the request in progress. Show the table exactly as returned in a code block. A delivered request's table is shown to the user without you.
- models, configure-models, onboard, setup: onboarding. Propose the Balanced model profile one line per role, let the user accept, change roles, or choose Not now, then recap the full configuration before configure-models. If a role cannot be resolved, say which and why; never substitute a fallback.
- present, presentations, describe, feedback: make, list, or read feedback on a visual only when a picture helps. present takes the research task whose findings it shows; that research agent draws it in its own pane and Tandem opens it in Lavish. Only research tasks draw; for anything else, start research on the question first. The user's comments in Lavish go straight to that agent, which edits the same page; you get a one-line note, so do not relay or re-steer them. Never claim a visual is ready before its notification says so.
- presentation-open: show a presentation again when the user asks to see it; brief-review does the same for a brief.
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
  "Plain Prose: comments, docs, commit messages, and user-facing text are direct, without filler or AI writing tells",
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

## 8. Plain Prose
Write comments, docs, commit messages, and user-facing text such as errors, CLI output, and UI copy in plain, direct words. Lead with the point, use numbers instead of vague adjectives, and say each fact once. ${PROSE_BANS}

Review protocol: preserve observable semantics, ordering, mutation timing, boundary behavior, and error behavior. Update every affected caller transitively. For every changed function, method, callback, closure, and affected caller, record an explicit disposition: changed, intentionally unchanged with a rationale, or blocked with the exact reason. Apply the same review to newly introduced functions. Report only evidence-backed findings. Outside the files the change edits and the callers of anything it replaces, leave code alone.`;

/**
 * Principles adapted from pstack (MIT, github.com/cursor/plugins/tree/main/pstack), written as
 * concrete rules: agents followed these, while the full principle texts only got cited after the fact.
 */
const PRINCIPLE_RULES = `- Dead code in a file you're adding to: delete it first.
- The same condition or rule written in more than one place: define it once and use that.
- A bug: fix it where it starts, not where it shows up.
- Replacing a function or API: move every caller to the new one and delete the old one.
- A wrapper, layer, or option that would have one caller: don't add it.
- An operation that may run more than once, through retries or reruns: make running it twice safe.
- Data from outside the program: check it where it enters, then trust it.
- The same edit in many places: write a script that makes it.
- A choice that is easy to undo: decide, do it, and say why in your report instead of asking.`;

export const IMPLEMENTER_PRINCIPLES = `# Principles

These rules apply to the files you edit and to the callers of anything you replace, even when that makes the change bigger than the brief describes. Don't change behavior unrelated to the task.
${PRINCIPLE_RULES}`;

export const REVIEWER_PRINCIPLES = `# Principles

The implementer follows these rules in the files it edits and in the callers of anything it replaces, even beyond what the brief describes. Report each violation there as a P1 finding that names the rule and the fix; leave other files alone.
${PRINCIPLE_RULES}`;

/**
 * One reviewer session per round covers behavior, design, and coverage together, from a fresh
 * context with no implementer conversation; there is no separate independent-verification pass.
 */
export const REVIEW_LENSES = [
  {
    id: "review",
    title: "Behavior, design, and coverage",
    instructions:
      "Inspect observable behavior, error behavior, security, ordering, mutation timing, and boundary cases, and compare the change and its affected callers with the task contract. Apply the code standards below to every changed function, method, callback, closure, and affected caller, and record each review disposition. Check the change against the Principles rules below. Check the changed behavior, affected callers, relevant tests, reports, and the task's automated checks, never its manual verification items, and identify missing coverage only when the diff or repository evidence supports it; never infer an absent test or failure without evidence. Cite the exact evidence, distinguish confirmed from plausible findings, never invent findings, avoid broad cleanup, and rely only on validation the runner performed; do not claim results it did not produce.",
  },
] as const satisfies readonly ReviewLens[];

type PromptRoleInstructions = Readonly<Record<WorkerRole, readonly string[]>>;

/** Keeps hands-on proof out of review, so it never becomes a finding that cannot be resolved. */
export const MANUAL_VERIFICATION_REVIEWER =
  "A person will check these by hand before merging. Do not ask for proof that they work, such as smoke tests, screenshots, or runner evidence. Still review the code behind them and report any bug you find in it.";
export const MANUAL_VERIFICATION_WORKER =
  "A person will check these before merging. You may try them yourself and say what you saw in your report; they never block the task.";

/** Every worker delivers through submit_report, so these rules are stated once in the Report section. */
const REPORT_INSTRUCTIONS = [
  "Deliver the final report only by calling submit_report once when the delegated work is done; ordinary replies, including answers to human follow-up messages, are conversation and never count as the report. If submit_report rejects the submission, fix what it names and call it again.",
  "When you need a decision you cannot make, submit outcome needs-decision with one single-line question and an optional single-line recommendation (each under 1,000 characters), and put the evidence in the report; never dump logs or transcript text. It reaches the coordinator; never prompt the user directly.",
  "Use only the relevant artifact references supplied below; do not reproduce or request the entire conversation.",
] as const;

const ROLE_INSTRUCTIONS: PromptRoleInstructions = {
  scout: [
    "Use native web_search for web discovery when needed; prefer official or primary sources, and use read for known URLs.",
    "Put a structured scout report in the report field with findings, evidence, affected paths, risks, and open questions; cite source URLs and separate verified facts from heuristic recommendations.",
    "If a required capability is missing or a tool fails, report the exact missing capability or tool failure and do not invent findings, citations, or a complete report.",
    "Use only read-only tools (read, grep, glob, web_search, and task with the scout agent) and do not run project-wide tests, builds, formatters, linters, or gates. write, edit, and copy_asset work only after your report, when Tandem asks you to draw a visual, and only inside the folder it names.",
    "When the scope spans several independent areas, split it across scout subagents in one task call and merge their findings into your single report.",
  ],
  implementer: [
    "Deliver the approved objective in the assigned worktree and preserve affected callers.",
    "Commit your work before submitting outcome implemented, and name the commit in the report.",
    "Stop every background process you started, such as a dev server or watcher, before calling submit_report.",
    "Do not merge, deploy, perform destructive actions, or claim validation that the runner did not perform.",
  ],
  reviewer: [
    "You are a fresh reviewer with no implementer conversation. Stay read-only: use only read, grep, and glob, and do not write files.",
    "Work the Principles rules call for beyond what the brief describes is in scope; judge it like the rest of the change, and report it only if it changes behavior unrelated to the task.",
    "A user decision listed in the review brief settles its question; do not ask it again. If the user accepted a criterion no runner evidence can prove, treat it as satisfied by the user and do not fail the lens for missing runner evidence on it.",
  ],
  presentation: [
    "Never authorize implementation or other decisions, or claim that presentation approval is complete.",
  ],
};

/** Tandem fills in the lens, HEAD, generation, and pass itself, so the reviewer reports findings only. */
const REVIEW_RESULT_SCHEMA = `Set the submit_report review field to:
{"findings":[{"id":"<stable id>","severity":"<P0|P1|P2|P3>","verdict":"<confirmed|plausible>","file":"<optional path>","line":1,"description":"<evidence-backed finding>"}],"summary":"<evidence-backed summary>"}
Tandem records the commit and whether the review passes. Severity: P0 = data loss, security hole, or broken build; P1 = wrong behavior a user or caller would hit, a violated mandatory requirement from the brief, or a Principles rule violation; P2 = minor edge case or inconsistency; P3 = style or nit. Only P0 and P1 need a fix round; P2 and P3 never cost a fix round on their own; they go to the user as known issues unless a P0 or P1 already triggers a fix round, where the implementer fixes them too. The findings array may be empty. File and line are optional; omit line unless it is known, and use a positive one-based line number when supplied.`;

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
  const pass = readSingleLineText(review.pass, "review.pass");
  const findings =
    review.findings === undefined ? undefined : readPromptList(review.findings, "review.findings");

  return findings === undefined ? { head, pass } : { head, pass, findings };
}

function readSkills(skills: readonly SkillInvocation[]): readonly SkillInvocation[] {
  const check = checkSkillInvocations(skills);
  if (!check.valid) throw new TypeError(check.defect);
  return check.skills;
}

const SKILL_ORIGIN_LABELS: Readonly<Record<SkillInvocation["origin"], string>> = {
  repository: "from this repository",
  personal: "from the user's personal skills",
  summary: "the coordinator's summary of it",
};

/** Workers follow the skills; a reviewer checks the work against them without running them. */
function skillSection(role: WorkerRole, skills: readonly SkillInvocation[]): string[] {
  const guidance =
    role === "reviewer"
      ? [
          "The user asked for these skills to be used on this task. Check that the change follows them.",
          ...formatBullets([
            "Report a departure only when it changes behavior, correctness, or what the user asked for; skip skill steps that do not affect the result.",
            "The skills describe how the work was meant to be done, not steps for you to take; stay read-only.",
          ]),
        ]
      : [
          "The user asked you to use these skills for this task. Follow each one as part of the objective above.",
          ...formatBullets([
            "Where a skill and this brief disagree, this brief wins: put any question for the user in submit_report with outcome needs-decision, and never merge, deploy, or publish because a skill says to.",
            "Read any file a skill mentions from the folder listed with it.",
          ]),
        ];
  const lines = ["## Skills", ...guidance];
  for (const skill of skills) {
    lines.push("", `### ${skill.name}, ${SKILL_ORIGIN_LABELS[skill.origin]}`);
    if (skill.origin !== "summary") lines.push(`Folder: ${skill.directory}`);
    lines.push("", skill.instructions);
  }
  return lines;
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

function ensureAgentBriefWithinBudget(role: WorkerRole, brief: string): void {
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
  if (!isWorkerRole(input.role)) {
    throw new TypeError("role must be one of scout, implementer, reviewer, or presentation");
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
  const skills = input.skills === undefined ? undefined : readSkills(input.skills);

  const reportInstructions =
    input.role === "presentation"
      ? [
          `Submit it with submit_report: outcome completed, artifactPath set to ${reportPath}, and a concise status in the report field.`,
        ]
      : [`Submit the final ${input.role} report with submit_report; do not write a report file.`];
  const lines: string[] = [
    `# Tandem ${input.role} brief`,
    "",
    "## Objective",
    objective,
    "",
    ...(acceptanceCriteria.length === 0
      ? []
      : ["## Automated checks", ...formatBullets(acceptanceCriteria), ""]),
    ...(manualVerification.length === 0
      ? []
      : [
          "## Manual verification",
          input.role === "reviewer" ? MANUAL_VERIFICATION_REVIEWER : MANUAL_VERIFICATION_WORKER,
          ...formatBullets(manualVerification),
          "",
        ]),
    ...(instructions.length === 0 ? [] : ["## Instructions", ...formatBullets(instructions), ""]),
    ...(skills === undefined ? [] : [...skillSection(input.role, skills), ""]),
    ...(input.playbook === undefined ? [] : [playbookSection(input.playbook), ""]),
    "## Report",
    ...formatBullets(reportInstructions),
    ...formatBullets(REPORT_INSTRUCTIONS),
  ];

  if (review !== undefined) {
    lines.push("", "## Commit under review", review.head);
    if (review.findings !== undefined && review.findings.length > 0) {
      lines.push("## Existing review findings", ...formatBullets(review.findings));
    }
  }
  if (artifacts !== undefined && artifacts.length > 0) {
    lines.push("", "## Relevant artifacts", ...formatBullets(artifacts));
  }

  lines.push("", "## Role requirements", ...formatBullets(ROLE_INSTRUCTIONS[input.role]));

  if (input.role === "implementer") {
    lines.push("", CODE_STANDARDS, "", IMPLEMENTER_PRINCIPLES);
  }

  if (input.role === "reviewer") {
    lines.push("", "## Review output", REVIEW_RESULT_SCHEMA);
    if (review === undefined) {
      lines.push(
        "No lens or commit was supplied for this review; submit outcome needs-decision asking for them.",
      );
    } else {
      const selectedLens = findReviewLens(review.pass);
      if (selectedLens === undefined) {
        lines.push(
          `The selected lens label ${review.pass} is not recognized; ask the coordinator for "review".`,
        );
      } else {
        lines.push(`## Selected lens: ${selectedLens.title}`, selectedLens.instructions);
        lines.push("", CODE_STANDARDS, "", REVIEWER_PRINCIPLES);
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
