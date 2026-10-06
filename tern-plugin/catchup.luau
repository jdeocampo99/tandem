--!strict
local views = require("./view-file")
local components = require("./components")
local navigation = require("./navigation")
local screen = require("./screen")
local ui = tern.ui

type Model = {catchup: {merged: {{number: number, title: string, url: string}}, needsYou: {{key: string, name: string, text: string}}, blocked: {{key: string, name: string, reason: string}}, whereWeLeftOff: {{workstream: string, text: string}}}}
type State = {view: views.View<Model>, args: {string}}
local function parse(value: unknown): Model?
 if type(value) ~= "table" or type(value.catchup) ~= "table" then return nil end
 local c = value.catchup
 for _, key in {"merged", "needsYou", "blocked", "whereWeLeftOff"} do if type(c[key]) ~= "table" then return nil end end
 for _, pr in c.merged do if type(pr) ~= "table" or type(pr.number) ~= "number" or type(pr.title) ~= "string" or type(pr.url) ~= "string" then return nil end end
 for _, row in c.needsYou do if type(row) ~= "table" or type(row.key) ~= "string" or type(row.name) ~= "string" or type(row.text) ~= "string" then return nil end end
 for _, row in c.blocked do if type(row) ~= "table" or type(row.key) ~= "string" or type(row.name) ~= "string" or type(row.reason) ~= "string" then return nil end end
 for _, row in c.whereWeLeftOff do if type(row) ~= "table" or type(row.workstream) ~= "string" or type(row.text) ~= "string" then return nil end end
 return value :: Model
end
local function section(title: string, rows: {Node}, tone: string?): Node
 if #rows == 0 then table.insert(rows, components.text("None", "muted")) end
 table.insert(rows, 1, ui.el("strong", {class="tdm-catchup-heading " .. (tone or ""), text=title}))
 return ui.el("div", {class="tdm-catchup-section"}, rows)
end
local block: BlockDef<State> = {
 init = function(cx, args, saved)
  local state: State = {args=screen.args(args, saved), view=views.create(screen.path(args, saved), "panel", parse)}
  views.refresh(state.view); views.watch(state.view, cx); return state
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
 key = function(state, key, cx) if key.name ~= "escape" then return false end navigation.run(navigation.origin(state.args), cx, {"board", "catchup-dismiss"}); return true end,
 event = function(state, ev, cx)
  if ev.ev ~= "action" then return end
  if ev.act == "dismiss" then navigation.run(navigation.origin(state.args), cx, {"board", "catchup-dismiss"})
  elseif state.view.status == "ready" then
   if ev.act == "open-needs" then navigation.run(navigation.origin(state.args), cx, {"board", "catchup-open-needs"})
   elseif ev.act == "merged" then navigation.run(navigation.origin(state.args), cx, {"board", "merged-link", ev.value}) end
  end
 end,
 save = function(state) return {args=state.args} end,
}
return block
