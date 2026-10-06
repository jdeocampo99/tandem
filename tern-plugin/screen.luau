--!strict
-- Drawing/lifecycle glue for board, usage and catch-up. All actions go through the guarded CLI.
local navigation = require("./navigation")
local components = require("./components")
local M = {}
function M.args(args: {string}, saved: unknown): {string}
 if #args > 0 then return args end
 if type(saved) == "table" and type(saved.args) == "table" then return saved.args end
 return {}
end
function M.path(args: {string}, saved: unknown): string
 return M.args(args, saved)[1] or ""
end
function M.back(args: {string}, cx: BlockCx)
 navigation.back(navigation.origin(args), cx)
end
function M.header(title: string, detail: string?): Node
 return tern.ui.el("div", {class="tdm-screen-header"}, {
  tern.ui.el("strong", {class="tdm-screen-title", text=title .. " · tandem"}),
  components.text(detail or "", "muted"), components.button("← Orchestrator", "back"),
 })
end
function M.status(nodes: {Node}, status: string)
 if status ~= "ready" then table.insert(nodes, components.text("View unavailable; waiting for a fresh update", "warn")) end
end
return M
