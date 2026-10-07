import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRecord } from "../../src/harness/contract.ts";
import { checkSetupAnswer, parseSetupAnswer } from "../../src/onboarding/setup-answer.ts";
import { setupSpecialists } from "../../src/onboarding/setup-view.ts";
import type { SpecialistFields } from "../../src/specialists/specialist.ts";
import { luauBinary } from "../luau.ts";
import { specialistsFixture } from "../onboarding/setup-fixture.ts";

/**
 * The Settings block checks a new specialist before Save; TypeScript checks it again and decides.
 * Every case goes through both. Whatever the block refuses, TypeScript must refuse too. A case
 * TypeScript refuses and the block lets through names why the block can't see it: the file it
 * would write, the frontmatter quoting, or whether the text reads back as written.
 */
type Verdict = "both accept" | "both refuse" | "whole file" | "quoting" | "reads back";
type Rule = Readonly<{ case: string; name: string; fields: SpecialistFields; verdict: Verdict }>;

const OK: SpecialistFields = { label: "Notes", instructions: "Keep it short.", steps: ["Draft"] };

function rule(
  name: string,
  fields: Partial<SpecialistFields>,
  verdict: Verdict,
  what: string,
): Rule {
  return { case: what, name, fields: { ...OK, ...fields }, verdict };
}

const RULES: readonly Rule[] = [
  rule("release-notes-weekly", {}, "both accept", "a valid specialist"),
  rule("", {}, "both refuse", "an empty name"),
  rule("Release-Notes", {}, "both refuse", "capitals in the name"),
  rule("-notes", {}, "both refuse", "a leading hyphen"),
  rule("a".repeat(40), {}, "both accept", "a 40-character name"),
  rule("a".repeat(41), {}, "both refuse", "a 41-character name"),
  rule("fix-round", {}, "both refuse", "the reserved name"),
  rule("release-notes", {}, "both refuse", "a name Just me has"),
  rule("notes", { label: "   " }, "both refuse", "a blank label"),
  rule("notes", { label: "😀".repeat(30) }, "both accept", "a 60-unit label"),
  rule("notes", { label: `${"😀".repeat(30)}a` }, "both refuse", "a 61-unit label"),
  rule("notes", { description: "  " }, "both accept", "a blank description"),
  rule("notes", { description: "d".repeat(301) }, "both refuse", "a 301-character description"),
  rule("notes", { instructions: " ", steps: [] }, "both refuse", "no instructions or steps"),
  rule("notes", { instructions: "", steps: ["Do it"] }, "both accept", "steps only"),
  rule("notes", { steps: ["Do it", "  "] }, "both refuse", "a blank step"),
  rule("notes", { steps: ["Do it", "Do it"] }, "both refuse", "a repeated step"),
  rule("notes", { steps: ["Do it", " Do it "] }, "both refuse", "a step repeated once trimmed"),
  rule(
    "notes",
    { instructions: "é".repeat(4096), steps: ["x"] },
    "both refuse",
    "instructions and steps over the byte limit",
  ),
  rule(
    "notes",
    { instructions: "a".repeat(8192), steps: [] },
    "whole file",
    "content at the limit in a file over it",
  ),
  rule("notes", { label: `say "hi" it's #1` }, "quoting", "a label no quoting can hold"),
  rule("notes", { instructions: "```\ncode" }, "reads back", "an unclosed code fence"),
  rule(
    "notes",
    { instructions: "Intro\n\n## Steps\n- a", steps: [] },
    "reads back",
    "a steps heading inside the instructions",
  ),
];

const CATALOGUE: readonly ModelRecord[] = [
  {
    selector: "anthropic/opus",
    id: "opus",
    provider: "anthropic",
    name: "Opus",
    thinking: ["high"],
  },
];

function typescriptProblems(entry: Rule): readonly string[] {
  const pick = { model: "anthropic/opus", thinking: "high" };
  const parsed = parseSetupAnswer(
    JSON.stringify({
      tandemSetup: 1,
      mode: "settings",
      models: {
        coordinator: pick,
        scout: pick,
        implementer: pick,
        reviewer: pick,
        presentation: pick,
      },
      repositories: [],
      selfImprovement: "fix",
      specialists: [{ op: "create", name: entry.name, fields: entry.fields }],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.problems.join(" "));
  const homeSpecialists = new Map<string, Readonly<{ revision?: string }>>();
  for (const file of specialistsFixture().files) {
    if (file.origin !== "home") continue;
    homeSpecialists.set(file.name, file.revision === undefined ? {} : { revision: file.revision });
  }
  return checkSetupAnswer(parsed.answer, {
    catalogue: CATALOGUE,
    repositories: new Map(),
    homeSpecialists,
  });
}

const PLUGIN = fileURLToPath(new URL("../../tern-plugin/", import.meta.url));
const JSON_CODEC = fileURLToPath(new URL("../evals/tern-parity/json.luau", import.meta.url));

function longString(text: string): string {
  let level = "";
  while (`${text}]`.includes(`]${level}]`)) level += "=";
  return `[${level}[\n${text}]${level}]`;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tandem-specialist-rules-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The block's verdict for each rule: its first problem, or "" when Save would be enabled. */
async function blockProblems(rules: readonly Rule[]): Promise<readonly string[]> {
  const model = setupSpecialists(specialistsFixture(), "/Users/me", "tandem");
  let source = `${await readFile(JSON_CODEC, "utf8")}
local ui = {}
function ui.node(kind, props, children) return { k = kind, p = props or {}, c = children } end
function ui.el(tag, props, children) return { k = "el", tag = tag, p = props or {}, c = children } end
function ui.text(spans) return { k = "text", c = spans } end
function ui.span(text, tone) return { k = "span", p = { text = text, tone = tone } } end
local tern = { ui = ui, json = json }
local modules = {}
local cache = {}
local function loadModule(name)
 if cache[name] == nil then cache[name] = modules[name]() end
 return cache[name]
end
`;
  for (const name of ["text-field", "components", "setup-specialists"]) {
    const module = await readFile(join(PLUGIN, `${name}.luau`), "utf8");
    source += `modules["./${name}"] = function()\n${module.replaceAll("require(", "loadModule(")}\nend\n`;
  }
  source += `
local fields = loadModule("./text-field")
local specialists = loadModule("./setup-specialists")
local model = json.decode(${longString(JSON.stringify(model))})
local verdicts = {}
for _, rule in json.decode(${longString(JSON.stringify(rules))}) do
 local form = {
  id = 1, name = fields.create(rule.name), label = fields.create(rule.fields.label),
  description = fields.create(rule.fields.description or ""), instructions = fields.create(rule.fields.instructions, true),
  steps = {}, locked = false,
 }
 for _, step in rule.fields.steps do table.insert(form.steps, fields.create(step)) end
 table.insert(verdicts, specialists.blocker(model, {forms = {}, creates = {form}, removes = {}}) or "")
end
print(json.encode(json.array(verdicts)))
`;
  const script = join(root, "rules.luau");
  await writeFile(script, source);
  const child = Bun.spawn([luauBinary(), script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout) as string[];
}

test("whatever the Settings block refuses, TypeScript refuses; its blind spots are named", async () => {
  const block = await blockProblems(RULES);
  const seen = RULES.map((entry, index) => {
    const blocked = (block[index] ?? "") !== "";
    const refused = typescriptProblems(entry).length > 0;
    if (blocked !== refused)
      return [entry.case, blocked ? "only the block refuses" : "a blind spot"];
    return [entry.case, blocked ? "both refuse" : "both accept"];
  });
  expect(seen).toEqual(
    RULES.map((entry) => [
      entry.case,
      entry.verdict === "both accept" || entry.verdict === "both refuse"
        ? entry.verdict
        : "a blind spot",
    ]),
  );
});
