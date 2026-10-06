--!strict
local ui = tern.ui
local views = require("./view-file")
local nav = require("./navigation")
local models = require("./pr-model")
local content = require("./pr-content")
local components = require("./components")
type State = { view: views.View<models.Model>, index: views.View<models.Index>?, content: content.State, cwd: string?, window: string, home: string, switcher: boolean }
local function invoke(s: State, cx: BlockCx): content.Invoke
 return function(verb, id, payload, done)
  if not s.cwd or string.sub(s.cwd, 1, 1) ~= "/" or string.sub(s.home, 1, 1) ~= "/" then
   local message = "The originating absolute cwd and native index path are required."
   cx:toast("error", "Tandem couldn't run that action", message); s.content.diff.busy = false
   if verb == "review-submit" and done then done({status=1,stdout="",stderr=message}) end
   return
  end
  local json = verb == "pr-comment" or verb == "review-submit"
  local argv = {"/bin/sh", if json then "native-input.sh" else "tandem.sh"}
  if not json then table.insert(argv, "native") end
  table.insert(argv, verb); table.insert(argv, id)
  if verb == "open" and type(payload) == "string" then table.insert(argv, payload) end
  table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", cx.pane))
  table.insert(argv, "--cwd"); table.insert(argv, s.cwd)
  if s.home ~= "" then table.insert(argv, "--home"); table.insert(argv, s.home) end
  local window = s.window
  if window and window ~= "" then table.insert(argv, "--window"); table.insert(argv, window) end
  local ok, problem = pcall(function()
   tern.process.run(argv, {cwd=".", stdin=if json then tern.json.encode(payload) else nil}, function(result)
    s.content.diff.busy = false
    if result.status ~= 0 then cx:toast("error", "Tandem couldn't run that action", result.stderr) end
    if done and (result.status == 0 or verb == "review-submit") then done(result) end
    if verb == "review-submit" and s.content.submitted then cx:exit(0); return end
    cx:render()
   end)
  end)
  if not ok then
   s.content.diff.busy = false; cx:toast("error", "Tandem couldn't start that action", tostring(problem))
   if verb == "review-submit" and done then done({status=1,stdout="",stderr=tostring(problem)}) end
  end
 end
end
local block: BlockDef<State> = {
 init = function(cx, args, _saved)
  local origin = nav.origin(args)
  local s: State = {view=views.create(origin.path, "pr", models.parse), content=content.create(), cwd=origin.cwd, window=origin.window, home=origin.home, switcher=false}
  views.watch(s.view, cx)
  local indexPath = nav.root(origin)
  if indexPath ~= origin.path then s.index = views.create(indexPath, "panel", models.parseIndex); views.watch(s.index, cx) end
  return s
 end,
 title = function(s) return if s.view.model then "#" .. s.view.model.header.number .. " ▾" else "Pull requests" end,
 view = function(s, _cx)
  local model = s.view.model
  local strip = ui.el("div", {class="tdm-pr-strip",key="strip"}, {ui.row({components.button(if model then "#" .. model.header.number .. " ▾" else "PRs ▾", "pr-switcher"), ui.node("text", {grow=1}), components.button("×", "pr-close")})})
  if not model then return {dock=strip, main=components.text("PR data unavailable. Wait for the coordinator to refresh its view.", "warn")} end
  local result = content.view(s.content, model, s.view.status == "ready", nil, strip)
  local top = {}
  if s.switcher and s.index and s.index.status == "ready" and s.index.model then
   local entries = {}
   for _, pr in s.index.model.pullRequests do table.insert(entries, pr) end
   table.sort(entries, function(a, b) return a.header.number < b.header.number end)
   for _, pr in entries do
    table.insert(top, components.button("#" .. pr.header.number .. " " .. pr.header.title, "pr-select=" .. pr.header.repo .. "#" .. pr.header.number))
   end
  end
  table.insert(top, result.main)
  return {main=ui.el("div", {class="tdm-pr-pane"},top),dock=result.dock}
 end,
 event = function(s, ev, cx)
  if ev.ev == "action" and ev.act == "pr-close" then cx:exit(0); return end
  if ev.ev == "action" and ev.act == "pr-switcher" then s.switcher = not s.switcher; return end
  if ev.ev == "action" and ev.act == "pr-select" and s.index and s.index.status == "ready" and s.index.model then
   local entries = {}
   for _, pr in s.index.model.pullRequests do table.insert(entries, pr) end
   table.sort(entries, function(a, b) return a.header.number < b.header.number end)
   local pr: typeof(entries[1])? = nil
   for _, entry in entries do if entry.header.repo .. "#" .. entry.header.number == ev.value then pr = entry end end
   if pr then
    invoke(s, cx)("open", "pr", pr.header.repo .. "#" .. pr.header.number, function() cx:exit(0) end)
    s.switcher = false
   end
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
