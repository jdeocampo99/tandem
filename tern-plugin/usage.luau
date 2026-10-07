--!strict
local components = require("./components")
local screen = require("./screen")
local rt = require("./rt")
local ui = tern.ui

type Cost = {model: string, cost: string, percent: number}
type State = {view: rt.Watch, args: {string}, origin: rt.Origin}
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
  local restored = screen.args(args, saved)
  local state: State = {args=restored, origin=rt.origin(restored), view=rt.watch(cx, screen.path(args, saved), "index")}
  return state
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
 key = function(state, key, cx) if key.name ~= "escape" then return false end screen.back(state.origin, cx); return true end,
 event = function(state, ev, cx) if ev.ev == "action" and ev.act == "back" then screen.back(state.origin, cx) end end,
 save = function(state) return {args=state.args} end,
}
return block
