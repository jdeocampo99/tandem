import { assemblePage, embedJson } from "../pages/assemble.ts";
import type { SetupView } from "./setup-view.ts";

/**
 * Turns the setup view model into one self-contained HTML page. The template, with the page's own
 * layout and the script that walks the six steps, lives next to this file; the shared tokens and
 * components (stepper, combobox, search list, pills, bottom bar) come from src/pages/.
 */
const PAGE_TEMPLATE_URL = new URL("./setup-page.html", import.meta.url);

export function renderSetupHtml(view: SetupView): string {
  return assemblePage(PAGE_TEMPLATE_URL, {
    data: `<script type="application/json" id="setup-data">${embedJson(view)}</script>`,
  });
}
