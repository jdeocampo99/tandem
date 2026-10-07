--!strict
local components = require("./components")
local rt = require("./rt")
local screen = require("./screen")
local ui = tern.ui

type State = {view: rt.Watch, args: {string}, origin: rt.Origin}
local function section(title: string, rows: {Node}, tone: string?): Node
 if #rows == 0 then table.insert(rows, components.text("None", "muted")) end
 table.insert(rows, 1, ui.el("strong", {class="tdm-catchup-heading " .. (tone or ""), text=title}))
 return ui.el("div", {class="tdm-catchup-section"}, rows)
end
local function leave(state: State, cx: BlockCx, verb: string)
 rt.act(cx, state.origin, {verb = verb}, function(outcome)
  if outcome and outcome.status == "done" then cx:exit(0) end
 end)
end
local block: BlockDef<State> = {
 init = function(cx, args, saved)
  local restored = screen.args(args, saved)
  local state: State = {args=restored, origin=rt.origin(restored), view=rt.watch(cx, screen.path(args, saved), "index")}
  return state
 end,
 title = function() return "Welcome back · Tandem" end,
 view = function(state)
  local children = {ui.el("div", {class="tdm-screen-header"}, {ui.el("strong", {text="Welcome back · tandem"}), components.text("Esc dismiss", "muted")}), ui.el("h2", {text="Since you left"})}
  screen.status(children, state.view.status)
  if state.view.model then
   local c = state.view.model.catchup
   local merged, needs, blocked, left = {}, {}, {}, {}
   for _, pr in c.merged do table.insert(merged, components.button("#" .. pr.number .. " " .. pr.title .. " ↗", "merged=" .. pr.url, "success")) end
   for _, row in c.needsYou do table.insert(needs, components.text(row.name .. ": " .. row.text)) end
   for _, row in c.blocked do table.insert(blocked, components.text(row.name .. ": " .. row.reason)) end
   for _, row in c.whereWeLeftOff do table.insert(left, ui.el("div", {class="tdm-usage-card"}, {ui.el("strong", {text="Workstream: " .. row.workstream}), ui.md(row.text)})) end
   table.insert(children, section("Merged", merged))
   table.insert(children, section("Needs you", needs, "tdm-needs"))
   table.insert(children, section("Blocked", blocked))
   table.insert(children, section("Where we left off", left))
  end
  local buttons = {components.button("Dismiss", "dismiss")}
  if state.view.status == "ready" and state.view.model and #state.view.model.catchup.needsYou > 0 then table.insert(buttons, 1, components.button("Open what needs me", "open-needs", "accent")) end
  table.insert(children, ui.el("div", {class="tdm-catchup-actions"}, buttons))
  return {main=ui.col({ui.el("div", {class="tdm-catchup-screen"}, children)})}
 end,
 key = function(state, key, cx) if key.name ~= "escape" then return false end leave(state, cx, "catchup-dismiss"); return true end,
 event = function(state, ev, cx)
  if ev.ev ~= "action" then return end
  if ev.act == "dismiss" then leave(state, cx, "catchup-dismiss")
  elseif state.view.status == "ready" then
   if ev.act == "open-needs" then leave(state, cx, "catchup-open-needs")
   elseif ev.act == "merged" then rt.act(cx, state.origin, {verb = "merged-link", url = ev.value}) end
  end
 end,
 save = function(state) return {args=state.args} end,
}
return block
