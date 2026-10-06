--!strict
local views = require("./view-file")
local components = require("./components")
local screen = require("./screen")
local ui = tern.ui

type Meter = {label: string, remaining: string, reset: string, fetched: string, percent: number?}
type Cost = {model: string, cost: string, percent: number}
type Display = {accounts: {{title: string, meters: {Meter}}}, totals: {{label: string, value: string}}, todayModels: {Cost}, weekModels: {Cost}, stages: {{label: string, today: string, week: string}}, updated: string, limitWarnings: {string}, warning: string?}
type Model = {usage: {display: Display}}
type State = {view: views.View<Model>, args: {string}}
local function parse(value: unknown): Model?
 if type(value) ~= "table" or type(value.usage) ~= "table" or type(value.usage.display) ~= "table" then return nil end
 local d = value.usage.display
 if type(d.accounts) ~= "table" or type(d.totals) ~= "table" or type(d.todayModels) ~= "table" or type(d.weekModels) ~= "table" or type(d.stages) ~= "table" then return nil end
 if d.warning ~= nil and type(d.warning) ~= "string" then return nil end
 if type(d.updated) ~= "string" or type(d.limitWarnings) ~= "table" then return nil end
 for _, warning in d.limitWarnings do if type(warning) ~= "string" then return nil end end
 for _, a in d.accounts do
  if type(a) ~= "table" or type(a.title) ~= "string" or type(a.meters) ~= "table" then return nil end
  for _, m in a.meters do
   if type(m) ~= "table" or type(m.label) ~= "string" or type(m.remaining) ~= "string" or type(m.reset) ~= "string" or type(m.fetched) ~= "string" or (m.percent ~= nil and type(m.percent) ~= "number") then return nil end
  end
 end
 for _, total in d.totals do if type(total) ~= "table" or type(total.label) ~= "string" or type(total.value) ~= "string" then return nil end end
 for _, rows in {d.todayModels, d.weekModels} do for _, row in rows do
  if type(row) ~= "table" or type(row.model) ~= "string" or type(row.cost) ~= "string" or type(row.percent) ~= "number" then return nil end
 end end
 for _, row in d.stages do if type(row) ~= "table" or type(row.label) ~= "string" or type(row.today) ~= "string" or type(row.week) ~= "string" then return nil end end
 return value :: Model
end
local function panel(title: string, children: {Node}): Node
 table.insert(children, 1, ui.el("div", {class="tdm-usage-label", text=title}))
 return ui.el("div", {class="tdm-usage-card"}, children)
end
local function chart(title: string, rows: {Cost}): Node
 local children = {}
 for _, row in rows do
  table.insert(children, ui.el("div", {class="tdm-chart-row"}, {
   ui.el("span", {class="tdm-chart-name", text=row.model}),
   ui.el("div", {class="tdm-chart-track"}, {ui.meter(row.percent / 100, {})}),
   ui.el("span", {text=row.cost}),
  }))
 end
 if #rows == 0 then table.insert(children, components.text("No recorded usage", "muted")) end
 return panel(title, children)
end
local block: BlockDef<State> = {
 init = function(cx, args, saved)
  local state: State = {args=screen.args(args, saved), view=views.create(screen.path(args, saved), "panel", parse)}
  views.refresh(state.view); views.watch(state.view, cx); return state
 end,
 title = function() return "Tandem usage" end,
 view = function(state)
  local children = {screen.header("Usage")}
  screen.status(children, state.view.status)
  if state.view.model then
   local display = state.view.model.usage.display
   local accounts = {}
   for _, account in display.accounts do
    local meters = {}
    for _, meter in account.meters do
     local parts = {ui.el("div", {class="tdm-meter-head"}, {ui.el("span", {text=meter.label}), ui.el("span", {text=meter.remaining .. " · " .. meter.reset})})}
     if meter.percent then table.insert(parts, ui.meter(meter.percent / 100, {})) end
     table.insert(parts, components.text(meter.fetched, "muted"))
     table.insert(meters, ui.el("div", {class="tdm-meter"}, parts))
    end
    table.insert(accounts, panel(account.title, meters))
   end
   if #accounts == 0 then table.insert(accounts, panel("Limits", {components.text("Provider limits unavailable", "muted")})) end
   table.insert(children, ui.el("div", {class="tdm-usage-accounts"}, accounts))
   table.insert(children, components.text(display.updated, "muted"))
   for _, warning in display.limitWarnings do table.insert(children, components.text(warning, "warn")) end
   local totals = {}
   for _, total in display.totals do table.insert(totals, ui.el("div", {class="tdm-usage-card"}, {ui.el("strong", {class="tdm-total", text=total.value}), ui.el("div", {class="tdm-usage-label", text=total.label})})) end
   table.insert(children, ui.el("div", {class="tdm-usage-totals"}, totals))
   local stages = {ui.el("div", {class="tdm-stage-row tdm-muted"}, {ui.el("span", {text="Stage"}), ui.el("span", {text="Today"}), ui.el("span", {text="Week"})})}
   for _, row in display.stages do table.insert(stages, ui.el("div", {class="tdm-stage-row"}, {ui.el("span", {text=row.label}), ui.el("span", {text=row.today}), ui.el("span", {text=row.week})})) end
   table.insert(children, ui.el("div", {class="tdm-usage-breakdown"}, {chart("Cost by model · today", display.todayModels), chart("Cost by model · week", display.weekModels), panel("Time per stage", stages)}))
   if display.warning then table.insert(children, components.text(display.warning, "warn")) end
  end
  return {main=ui.col({ui.el("div", {class="tdm-usage-screen"}, children)})}
 end,
 key = function(state, key, cx) if key.name ~= "escape" then return false end screen.back(state.args, cx); return true end,
 event = function(state, ev, cx) if ev.ev == "action" and ev.act == "back" then screen.back(state.args, cx) end end,
 save = function(state) return {args=state.args} end,
}
return block
