import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ViewNode } from "./harness.ts";

export type Appearance = "light" | "dark";

/** A string a block draws and how legible it is against what is behind it. */
export type Painted = Readonly<{
  text: string;
  /** WCAG contrast ratio of the text against its composited background, 1 to 21. */
  contrast: number;
  /** The text color or a background behind it comes from Tandem's stylesheets, not Tern's theme. */
  tandemColored: boolean;
}>;

type Rgba = readonly [number, number, number, number];
type Paint = Readonly<{ rgba: Rgba; tandem: boolean }>;

const PLUGIN = fileURLToPath(new URL("../../../tern-plugin/", import.meta.url));

/**
 * Tern's built-in `light` and `titanium` themes, the two appearances the live screenshots were
 * taken in: the pane behind every block, the ink text inherits, and the colors of span tones.
 */
const THEMES: Readonly<
  Record<
    Appearance,
    Readonly<{ pane: string; ink: string; tones: Readonly<Record<string, string>> }>
  >
> = {
  light: {
    pane: "#f8f8f8",
    ink: "#3b3b3b",
    tones: {
      strong: "#3b3b3b",
      muted: "#6c6c6c",
      accent: "#5a8080",
      success: "#588458",
      warn: "#9a7326",
      danger: "#aa5555",
    },
  },
  dark: {
    pane: "#13161c",
    ink: "#e8ecf4",
    tones: {
      strong: "#e8ecf4",
      muted: "#9ca3b0",
      accent: "#00b4ff",
      success: "#00ff88",
      warn: "#ffb347",
      danger: "#ff4757",
    },
  },
};

type Compound = Readonly<{ tag: string | undefined; classes: readonly string[] }>;
/** A selector read right to left: the subject first, then each ancestor step and how it is joined. */
type Selector = Readonly<{
  steps: readonly Readonly<{ compound: Compound; child: boolean }>[];
  specificity: number;
}>;
type Rule = Readonly<{
  selector: Selector;
  order: number;
  declarations: Readonly<Record<string, string>>;
}>;

function compound(text: string): Compound {
  const [tag, ...classes] = text.split(".");
  return { tag: tag === "" || tag === "*" ? undefined : tag, classes };
}

/** Pseudo-classes describe hover and structure, not the resting colors, so those selectors drop out. */
function selector(text: string): Selector | undefined {
  if (text.includes(":")) return undefined;
  const tokens = text
    .replace(/\s*>\s*/g, " > ")
    .trim()
    .split(/\s+/);
  const steps: { compound: Compound; child: boolean }[] = [];
  let child = false;
  for (const token of tokens.toReversed()) {
    if (token === ">") {
      child = true;
      continue;
    }
    steps.push({ compound: compound(token), child });
    child = false;
  }
  const specificity = steps.reduce(
    (sum, step) => sum + step.compound.classes.length * 100 + (step.compound.tag ? 1 : 0),
    0,
  );
  return { steps, specificity };
}

function parseSheet(css: string, offset: number): Rule[] {
  const rules: Rule[] = [];
  for (const [, selectors = "", body = ""] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const declarations: Record<string, string> = {};
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0)
        declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    for (const text of selectors.split(",")) {
      const parsed = selector(text.trim());
      if (parsed !== undefined)
        rules.push({ selector: parsed, order: offset + rules.length, declarations });
    }
  }
  return rules;
}

const Manifest = z.object({ styles: z.array(z.string()) });
const RULES: readonly Rule[] = (
  await Promise.all(
    Manifest.parse(Bun.TOML.parse(await readFile(join(PLUGIN, "plugin.toml"), "utf8"))).styles.map(
      (file) => readFile(join(PLUGIN, file), "utf8"),
    ),
  )
).flatMap((css, index) => parseSheet(css, index * 10_000));

/** Arguments of a CSS function, split on its top-level commas. */
function args(value: string, name: string): string[] | undefined {
  if (!value.startsWith(`${name}(`) || !value.endsWith(")")) return undefined;
  const parts: string[] = [];
  let depth = 0;
  let start = name.length + 1;
  for (let index = start; index < value.length - 1; index++) {
    const char = value[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start, -1).trim());
  return parts;
}

function color(value: string, appearance: Appearance): Rgba {
  const choices = args(value, "light-dark");
  if (choices?.length === 2)
    return color(choices[appearance === "light" ? 0 : 1] ?? "", appearance);
  if (value === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex !== undefined && [3, 4, 6, 8].includes(hex.length)) {
    const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : hex.match(/../g);
    const [r = 0, g = 0, b = 0, a = 255] = (digits ?? []).map((pair) => Number.parseInt(pair, 16));
    return [r, g, b, a / 255];
  }
  const channels = args(value, "rgba") ?? args(value, "rgb");
  if (channels !== undefined && channels.length >= 3) {
    const [r = 0, g = 0, b = 0, a = 1] = channels.map(Number);
    return [r, g, b, a];
  }
  throw new Error(`the appearance model cannot read the color ${value}`);
}

function over(top: Rgba, under: Rgba): Rgba {
  const alpha = top[3];
  return [
    top[0] * alpha + under[0] * (1 - alpha),
    top[1] * alpha + under[1] * (1 - alpha),
    top[2] * alpha + under[2] * (1 - alpha),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

type Element = Readonly<{ tag: string; classes: readonly string[] }>;

function element(node: ViewNode): Element {
  const classes = typeof node.p.class === "string" ? node.p.class.split(/\s+/) : [];
  return { tag: node.tag ?? "div", classes };
}

function matches(target: Compound, at: Element | undefined): boolean {
  return (
    at !== undefined &&
    (target.tag === undefined || target.tag === at.tag) &&
    target.classes.every((name) => at.classes.includes(name))
  );
}

/** `chain` runs from the drawn slot down to the element being styled. */
function selects(rule: Selector, chain: readonly Element[]): boolean {
  const [subject, ...ancestors] = rule.steps;
  let index = chain.length - 1;
  if (subject === undefined || !matches(subject.compound, chain[index])) return false;
  let child = subject.child;
  for (const step of ancestors) {
    index--;
    if (child) {
      if (!matches(step.compound, chain[index])) return false;
    } else {
      while (index >= 0 && !matches(step.compound, chain[index])) index--;
      if (index < 0) return false;
    }
    child = step.child;
  }
  return true;
}

function declared(chain: readonly Element[], property: string): string | undefined {
  let winner: Rule | undefined;
  for (const rule of RULES) {
    if (!(property in rule.declarations) || !selects(rule.selector, chain)) continue;
    if (
      winner === undefined ||
      rule.selector.specificity > winner.selector.specificity ||
      (rule.selector.specificity === winner.selector.specificity && rule.order > winner.order)
    )
      winner = rule;
  }
  return winner?.declarations[property];
}

/**
 * The legibility of every string a slot draws in one appearance. Tern draws a slot's root node
 * only through its children, so the root's own class never reaches the page. Badges, fields,
 * markdown and rules are Tern widgets that bring their own colors and are not judged here.
 */
export function paint(root: ViewNode, appearance: Appearance): Painted[] {
  const theme = THEMES[appearance];
  const drawn: Painted[] = [];
  const visit = (node: ViewNode, chain: readonly Element[], ink: Paint, behind: Paint): void => {
    const here = [...chain, element(node)];
    const background = declared(here, "background") ?? declared(here, "background-color");
    const layer = background === undefined ? undefined : color(background, appearance);
    const fill: Paint =
      layer === undefined || layer[3] === 0
        ? behind
        : { rgba: over(layer, behind.rgba), tandem: true };
    const own = declared(here, "color");
    let pen: Paint = own === undefined ? ink : { rgba: color(own, appearance), tandem: true };
    const tone = node.p.tone;
    if (node.k === "span" && typeof tone === "string" && tone !== "") {
      const toned = theme.tones[tone];
      if (toned === undefined) throw new Error(`the appearance model has no Tern tone ${tone}`);
      pen = { rgba: color(toned, appearance), tandem: false };
    }
    const text = node.p.text;
    if ((node.k === "span" || node.k === "el") && typeof text === "string" && text.trim() !== "")
      drawn.push({
        text,
        contrast: contrast(over(pen.rgba, fill.rgba), fill.rgba),
        tandemColored: pen.tandem || fill.tandem,
      });
    for (const child of node.c) visit(child, here, pen, fill);
  };
  const ink: Paint = { rgba: color(theme.ink, appearance), tandem: false };
  const pane: Paint = { rgba: color(theme.pane, appearance), tandem: false };
  for (const child of root.c) visit(child, [], ink, pane);
  return drawn;
}
