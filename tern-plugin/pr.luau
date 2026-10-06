--!strict
local ui = tern.ui
local views = require("./view-file")
local models = require("./pr-model")
local content = require("./pr-content")
local components = require("./components")
type Index = { pullRequests: { [string]: { header: { number: number, title: string, taskId: string?, repo: string }, detailFile: string } } }
type State = { view: views.View<models.Model>, index: views.View<Index>?, content: content.State, cwd: string?, switcher: boolean }
local function parseIndex(value: unknown): Index?
 if type(value) ~= "table" or type(value.pullRequests) ~= "table" then return nil end
 for _, pr in value.pullRequests do
  if type(pr) ~= "table" or type(pr.header) ~= "table" or type(pr.header.number) ~= "number" or type(pr.header.title) ~= "string" or type(pr.detailFile) ~= "string" then return nil end
 end
 return value :: Index
end
local function invoke(s: State, cx: BlockCx): content.Invoke
 return function(verb, id, payload, done)
  if not s.cwd or string.sub(s.cwd, 1, 1) ~= "/" then cx:toast("error", "Tandem couldn't run that action", "The originating absolute cwd is required."); s.content.diff.busy = false; return end
  local json = verb == "pr-comment" or verb == "review-submit"
  local argv = {"/bin/sh", if json then "pr-input.sh" else "tandem.sh"}
  if not json then table.insert(argv, "native") end
  table.insert(argv, verb); table.insert(argv, id)
  if verb == "open" and type(payload) == "string" then table.insert(argv, payload) end
  table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", cx.pane))
  table.insert(argv, "--cwd"); table.insert(argv, s.cwd)
  local window = tern.getenv("TERN_WINDOW_KEY")
  if window and window ~= "" then table.insert(argv, "--window"); table.insert(argv, window) end
  local ok, problem = pcall(function()
   tern.process.run(argv, {cwd=".", stdin=if json then tern.json.encode(payload) else nil}, function(result)
    s.content.diff.busy = false
    if result.status ~= 0 then cx:toast("error", "Tandem couldn't run that action", result.stderr)
    elseif done then done() end
    cx:render()
   end)
  end)
  if not ok then s.content.diff.busy = false; cx:toast("error", "Tandem couldn't start that action", tostring(problem)) end
 end
end
local block: BlockDef<State> = {
 init = function(cx, args, _saved)
  local s: State = {view=views.create(args[1] or "", "pr", models.parse), content=content.create(), cwd=args[4] or cx.cwd, switcher=false}
  views.watch(s.view, cx)
  if args[2] and args[2] ~= "" then s.index = views.create(args[2], "panel", parseIndex); views.watch(s.index, cx) end
  return s
 end,
 title = function(s) return if s.view.model then "#" .. s.view.model.header.number .. " ▾" else "Pull requests" end,
 view = function(s, _cx)
  local model = s.view.model
  local strip = ui.row({components.button(if model then "#" .. model.header.number .. " ▾" else "PRs ▾", "pr-switcher"), components.button("×", "pr-close")})
  if not model then return {dock=strip, main=components.text("PR data unavailable. Wait for the coordinator to refresh its view.", "warn")} end
  local result = content.view(s.content, model, s.view.status == "ready")
  local top = {strip}
  if s.switcher and s.index and s.index.status == "ready" and s.index.model then
   local entries = {}
   for _, pr in s.index.model.pullRequests do table.insert(entries, pr) end
   table.sort(entries, function(a, b) return a.header.number < b.header.number end)
   for i, pr in entries do
    if pr.header.taskId then table.insert(top, components.button("#" .. pr.header.number .. " " .. pr.header.title, "pr-select=" .. i)) end
   end
  end
  table.insert(top, result.main)
  return {main=ui.col(top)}
 end,
 event = function(s, ev, cx)
  if ev.ev == "action" and ev.act == "pr-close" then cx:exit(0); return end
  if ev.ev == "action" and ev.act == "pr-switcher" then s.switcher = not s.switcher; return end
  if ev.ev == "action" and ev.act == "pr-select" and s.index and s.index.status == "ready" and s.index.model then
   local entries = {}
   for _, pr in s.index.model.pullRequests do table.insert(entries, pr) end
   table.sort(entries, function(a, b) return a.header.number < b.header.number end)
   local pr = entries[tonumber(ev.value) or 0]
   if pr and pr.header.taskId then invoke(s, cx)("open", "pr", pr.header.taskId); s.switcher = false end
   return
  end
  if s.view.model then content.event(s.content, s.view.model, s.view.status == "ready", ev, cx, invoke(s, cx)) end
 end,
 key = function(s, key, cx)
  if s.view.model and content.key(s.content, s.view.model, s.view.status == "ready", key, cx, invoke(s, cx)) then return true end
  if key.name == "escape" then if s.switcher then s.switcher = false else cx:exit(0) end; return true end
  if key.name == "pageup" or key.name == "pagedown" or key.name == "home" or key.name == "end" then
   local action = if key.name == "home" then "start" elseif key.name == "end" then "end" elseif key.name == "pageup" then "page-up" else "page-down"
   cx:frame({{"scroll", "main", action}}); return true
  end
  return false
 end,
 save = function(_s) return {} end,
}
return block
