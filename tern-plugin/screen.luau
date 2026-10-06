--!strict
-- Drawing/lifecycle glue for board, usage and catch-up. All actions go through the guarded CLI.
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
function M.run(args: {string}, cx: BlockCx, action: {string})
 local cwd = args[3] or cx.cwd
 if not cwd or string.sub(cwd, 1, 1) ~= "/" then cx:toast("error", "Tandem couldn't run that action", "An absolute project cwd is required."); return end
 local argv = {"/bin/sh", "tandem.sh", "native"}
 for _, arg in action do table.insert(argv, arg) end
 table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", cx.pane))
 table.insert(argv, "--cwd"); table.insert(argv, cwd)
 if args[4] and args[4] ~= "" then table.insert(argv, "--window"); table.insert(argv, args[4]) end
 local ok, problem = pcall(function()
  tern.process.run(argv, {cwd="."}, function(result)
   if result.status ~= 0 then cx:toast("error", "Tandem couldn't run that action", result.stderr) end
  end)
 end)
 if not ok then cx:toast("error", "Tandem couldn't start that action", tostring(problem)) end
end
function M.back(args: {string}, cx: BlockCx, kind: string)
 M.run(args, cx, {kind, "back"})
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
