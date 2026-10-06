--!strict
local ui = tern.ui
local views = require("./view-file")
local rt = require("./rt")
local models = require("./pr-model")
local content = require("./pr-content")
local components = require("./components")
type State = { view: views.View<models.Model>, index: views.View<models.Index>?, content: content.State, origin: rt.Origin, switcher: boolean }
local function invoke(s: State, cx: BlockCx): content.Invoke
 return function(action, done)
  local sent = rt.act(cx, s.origin, action, function(outcome)
   s.content.diff.busy = false
   if done then done(outcome) end
   if action.verb == "review-submit" and s.content.submitted then cx:exit(0); return end
   cx:render()
  end)
  if not sent then
   s.content.diff.busy = false
   if action.verb == "review-submit" and done then done(nil) end
  end
 end
end
local block: BlockDef<State> = {
 init = function(cx, args, _saved)
  local path = args[1] or ""
  local s: State = {view=views.create(path, "pr", models.parse), content=content.create(), origin=rt.origin(args), switcher=false}
  views.watch(s.view, cx)
  local indexPath = args[3] or ""
  if indexPath ~= path then s.index = views.create(indexPath, "panel", models.parseIndex); views.watch(s.index, cx) end
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
    invoke(s, cx)({verb="open",ref={kind="pr",repo=pr.header.repo,number=pr.header.number}}, function(outcome) if outcome and outcome.status == "done" then cx:exit(0) end end)
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
