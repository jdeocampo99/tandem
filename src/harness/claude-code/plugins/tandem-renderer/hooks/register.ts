import type { Register } from "claude-code";

/**
 * Tandem shows each wake with `$.ui.log` and submits it, with its hidden part, as a prompt. The
 * submitted row would show the text twice and the hidden part to the person, so it draws as
 * nothing until the person expands it.
 */
export const register: Register = (on) => {
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const { origin, isExpanded } = e.props;
    if (isExpanded || origin.kind !== "plugin" || origin.name !== "tandem") return next(e);
    const { Box } = $.ui.resolve(e);
    return Box({});
  });
};
