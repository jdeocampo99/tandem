import { coordinatorSourceGuidance } from "../config/environment.ts";
import {
  COORDINATOR_INSTRUCTIONS,
  COORDINATOR_TOOL_GUIDANCE,
  TANDEM_COORDINATOR_INSTRUCTIONS,
} from "../instructions.ts";
import { remainingOnboardingSteps, SETUP_WELCOME_TEXT } from "../onboarding/checklist.ts";
import type { SourceRefreshResult, TandemService } from "../service/controller.ts";
import { WELCOME_TEXT } from "../terminal/welcome.ts";
import type { CoordinatorDeps } from "./coordinator.ts";
import { OnboardingGuide } from "./onboarding-guide.ts";
import { buildDurableDigest } from "./summary.ts";

/** What the coordinator is told about its source checkout after a successful refresh. */
export function sourceRefreshStatus(refreshed: SourceRefreshResult | undefined): string {
  if (refreshed?.changed === true) {
    return `Coordinator source advanced from ${refreshed.previousHead} to ${refreshed.head}; earlier file observations and repository guidance may be stale. Existing tasks remain pinned to their captured commits.`;
  }
  if (refreshed?.localOnly) {
    return "Coordinator source is local-only; no origin/main refresh is configured. Existing tasks remain pinned to their captured commits.";
  }
  return "Coordinator source is current for this turn. Existing tasks remain pinned to their captured commits.";
}

const INITIAL_SOURCE_STATUS =
  "Source is refreshed only at the start of a new coordinator turn; tasks already created remain pinned to their captured commit.";

const OPERATION_FAILED = "Tandem extension operation failed";

/** Workstream notes only add context, so notes that cannot be read never hold up a turn. */
async function workstreamLines(service: TandemService, repo: string): Promise<readonly string[]> {
  try {
    return await service.memoryList(repo);
  } catch {
    return [];
  }
}

type ContextDeps = Pick<
  CoordinatorDeps,
  | "environment"
  | "host"
  | "realpath"
  | "isTandemCheckout"
  | "openWelcome"
  | "openSetup"
  | "logError"
>;

/** The standing coordinator context and the Tandem checkout's first-time setup. */
export class CoordinatorContext {
  sourceStatus = INITIAL_SOURCE_STATUS;
  private isTandemCheckout: Promise<boolean> | undefined;
  private onboardingGuide: OnboardingGuide | undefined;

  constructor(
    private readonly deps: ContextDeps,
    private readonly service: () => TandemService,
  ) {}

  async build(service: TandemService): Promise<Readonly<{ context: string[]; digest: string }>> {
    const digest = buildDurableDigest(await service.list());
    const workstreams = await workstreamLines(service, this.deps.environment.repo);
    return {
      context: [
        COORDINATOR_INSTRUCTIONS,
        COORDINATOR_TOOL_GUIDANCE,
        ...(await this.tandemContext()),
        coordinatorSourceGuidance(this.deps.environment),
        this.sourceStatus,
        digest,
        ...(workstreams.length === 0 ? [] : [`Workstreams: ${workstreams.join(" · ")}`]),
      ],
      digest,
    };
  }

  async sessionStart(): Promise<void> {
    await this.welcome().catch((error) => this.deps.logError(OPERATION_FAILED, error));
    if (await this.tandemCheckout()) {
      await this.onboarding()
        .sessionStart()
        .catch((error) => this.deps.logError(OPERATION_FAILED, error));
    }
  }

  async afterAction(): Promise<void> {
    if (await this.tandemCheckout()) await this.onboarding().afterAction();
  }

  /**
   * What only the Tandem coordinator reads: its instructions, and where first-time setup stands,
   * read fresh each time. Setup state that cannot be read is left out rather than guessed.
   */
  private async tandemContext(): Promise<readonly string[]> {
    if (!(await this.tandemCheckout())) return [];
    const setup = await this.onboarding()
      .context()
      .catch(() => []);
    return [TANDEM_COORDINATOR_INSTRUCTIONS, ...setup];
  }

  private onboarding(): OnboardingGuide {
    this.onboardingGuide ??= new OnboardingGuide({
      host: this.deps.host,
      service: this.service,
      repo: this.deps.environment.repo,
    });
    return this.onboardingGuide;
  }

  private tandemCheckout(): Promise<boolean> {
    this.isTandemCheckout ??= this.deps.isTandemCheckout();
    return this.isTandemCheckout;
  }

  /**
   * The Tandem coordinator opens the setup block beside the chat while setup is unfinished, and
   * otherwise greets the user while no other project is set up. When a terminal has no setup block
   * the checklist runs in the chat. When the welcome popup cannot open (an older Herdr, or the
   * plugin is not linked), the same words arrive in the chat instead.
   */
  private async welcome(): Promise<void> {
    if (!(await this.tandemCheckout())) return;
    if (await this.openSetupBlock()) return;
    const repo = await this.deps.realpath(this.deps.environment.repo);
    const { projects } = await this.service().board();
    if (projects.some((project) => project !== repo)) return;
    try {
      await this.deps.openWelcome();
    } catch {
      await this.deliverStartupText(WELCOME_TEXT);
    }
  }

  /** Whether the setup block opened; a block that cannot open leaves setup to the chat. */
  private async openSetupBlock(): Promise<boolean> {
    const facts = await this.service().onboardingFacts(this.deps.environment.repo);
    if (remainingOnboardingSteps(facts).length === 0) return false;
    try {
      if (!(await this.deps.openSetup())) return false;
    } catch (error) {
      this.deps.logError(OPERATION_FAILED, error);
      return false;
    }
    this.onboarding().setupBlockOpened();
    await this.deliverStartupText(SETUP_WELCOME_TEXT);
    return true;
  }

  private deliverStartupText(text: string): Promise<void> {
    return this.deps.host.perform({
      type: "deliver",
      source: "notification",
      text,
      timing: "nextTurn",
      triggerTurn: false,
    });
  }
}
