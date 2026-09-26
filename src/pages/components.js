// components.js: page script shared by Tandem's pages, inlined at build time (src/pages/assemble.ts).
// Styles for each component live in tandem.css.
window.TandemUI = (() => {
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  /** Text safe to put in markup and attribute values. */
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  /** Lowercased words of a query; an item matches when it contains every one. */
  const words = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

  /**
   * A searchable dropdown: type to narrow (every word must match an item's search text), arrow
   * keys to move, Enter to pick, Escape to put the last pick back. The list widens to fit and
   * opens upward when it would run under the page's bottom bar (`.bar`) or off the screen.
   *
   * items: [{ label, search, cells: [text...] }]; chosen: the picked item or undefined;
   * onPick(item) runs on a pick and usually redraws the row that holds the box.
   */
  function combobox({ id, label, items, chosen, placeholder, empty, onPick }) {
    const wrap = document.createElement("div");
    wrap.className = "combo";
    const listId = `${id}-list`;
    wrap.innerHTML = `<input type="text" id="${esc(id)}" role="combobox" aria-label="${esc(label)}" aria-controls="${esc(listId)}" aria-expanded="false" aria-autocomplete="list" autocomplete="off" placeholder="${esc(placeholder)}" value="${chosen ? esc(chosen.label) : ""}"><ul class="combo-list" id="${esc(listId)}" role="listbox" hidden></ul>`;
    const input = wrap.querySelector("input");
    const list = wrap.querySelector("ul");
    let matches = [];
    let active = 0;
    const draw = () => {
      const q = words(input.value === chosen?.label ? "" : input.value);
      matches = items.filter((item) => q.every((w) => item.search.toLowerCase().includes(w)));
      active = Math.min(active, Math.max(matches.length - 1, 0));
      list.innerHTML = matches.length
        ? matches
            .map(
              (item, n) =>
                `<li role="option" id="${esc(id)}-o${n}" aria-selected="${n === active}" data-n="${n}"><b>${esc(item.label)}</b>${item.cells.map((cell) => `<span class="num">${esc(cell)}</span>`).join("")}</li>`,
            )
            .join("")
        : `<li class="none">${esc(empty)}</li>`;
      list.hidden = false;
      const bar = document.querySelector(".bar")?.getBoundingClientRect().top ?? window.innerHeight;
      const box = input.getBoundingClientRect();
      const below = bar - box.bottom;
      list.classList.toggle("up", below < Math.min(list.scrollHeight, 240) + 12 && box.top > below);
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-activedescendant", matches.length ? `${id}-o${active}` : "");
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.value = chosen ? chosen.label : "";
    };
    const pick = (n) => {
      const item = matches[n];
      if (item) onPick(item);
    };
    input.addEventListener("focus", () => {
      input.select();
      active = 0;
      draw();
    });
    input.addEventListener("input", () => {
      active = 0;
      draw();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        active = Math.min(active + 1, matches.length - 1);
        draw();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        draw();
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(active);
      } else if (e.key === "Escape") {
        close();
        input.blur();
      }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("[data-n]");
      if (!li) return;
      e.preventDefault();
      pick(Number(li.dataset.n));
    });
    return wrap;
  }

  return { esc, words, combobox };
})();
