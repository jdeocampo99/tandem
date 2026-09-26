import { readFileSync } from "node:fs";

/**
 * Builds Tandem's self-contained HTML pages: every page template inlines the shared stylesheet
 * (`tandem.css`) and, when it needs them, the shared page script (`components.js`), then the page
 * fills its own placeholders. Nothing is fetched at view time except the web fonts.
 */
const SHARED_ASSETS: Readonly<Record<string, URL>> = {
  "tandem.css": new URL("./tandem.css", import.meta.url),
  "components.js": new URL("./components.js", import.meta.url),
};

/**
 * `{{name}}`, or `/*{{name}}*\/` inside a `<style>` or `<script>` so the template stays valid CSS
 * or JavaScript for the linter; the comment goes with the placeholder.
 */
const PLACEHOLDER = /\/\*\{\{([a-z][a-z.]*)\}\}\*\/|\{\{([a-z][a-z.]*)\}\}/g;

/**
 * Fills placeholders: the shared assets by name, then `fills`. A placeholder with no value is an
 * error, so a template and its renderer cannot drift apart silently.
 */
export function assemblePage(templateUrl: URL, fills: Readonly<Record<string, string>>): string {
  const template = readFileSync(templateUrl, "utf8");
  return template.replace(PLACEHOLDER, (_match, commented: string | undefined, plain: string) => {
    const key = commented ?? plain;
    const asset = SHARED_ASSETS[key];
    if (asset !== undefined) return readFileSync(asset, "utf8");
    const fill = fills[key];
    if (fill === undefined) throw new Error(`Page template has no value for ${key}`);
    return fill;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON safe inside a `<script>` element: no `<`, `>`, or `&` can close it or open a comment. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}
