--!strict
local components = require("./components")
local rt = require("./rt")
local screen = require("./screen")
local ui = tern.ui

type Card = { key: string, title: string, branch: string?, detail: string, time: string?, model: string?, costLabel: string?, harnessGlyph: string?, stuck: boolean, pullRequest: { number: number, draft: boolean, url: string }? }
type Lane = { title: string, count: number, cards: { Card } }
type State = { view: rt.Watch, args: { string }, origin: rt.Origin }

local function cardNode(card: Card): Node
 local title = {ui.el("span", {class="tdm-harness", text=card.harnessGlyph or ""}), ui.el("strong", {text=card.title})}
 if card.stuck then table.insert(title, ui.el("span", {class="tdm-stuck", text="stuck"})) end
 local foot = {ui.el("span", {text=card.model or "model unavailable"}), ui.el("span", {text=card.costLabel or "cost unavailable"})}
 if card.pullRequest then
  table.insert(foot, components.button("#" .. card.pullRequest.number .. (if card.pullRequest.draft then " draft" else " open") .. " ↗", "pr=" .. card.key, "accent"))
 end
 return ui.el("div", {class="tdm-board-card", key=card.key}, {
  ui.el("div", {class="tdm-board-title"}, title),
  ui.el("div", {class="tdm-branch", text=card.branch or "branch unavailable"}),
  ui.el("div", {class="tdm-board-reason"}, {ui.el("span", {text=card.detail}), ui.el("span", {class="tdm-age", text=card.time or ""})}),
  ui.el("div", {class="tdm-board-foot"}, foot),
 })
end

local block: BlockDef<State> = {
 init = function(cx, args, saved)
  local restored = screen.args(args, saved)
  local state: State = {args=restored, origin=rt.origin(restored), view=rt.watch(cx, screen.path(args, saved), "index")}
  return state
 end,
 title = function() return "Tandem board" end,
 view = function(state)
  local model = state.view.model
  local children = {screen.header("Board", "view-only · ⌘⇧B or Esc to close")}
  screen.status(children, state.view.status)
  if model then
   local lanes = {}
   local colors = {"working", "needs", "review", "ready"}
   for i, lane in model.board.lanes do
    local cards = {}
    for _, card in lane.cards do table.insert(cards, cardNode(card)) end
    if #cards == 0 then table.insert(cards, components.text("All quiet", "muted")) end
    table.insert(lanes, ui.el("div", {class="tdm-board-lane", key=lane.title}, {
     ui.el("div", {class="tdm-lane-head tdm-" .. colors[i]}, {ui.el("span", {text="● " .. lane.title}), ui.el("span", {class="tdm-age", text=tostring(lane.count)})}),
     ui.el("div", {class="tdm-board-cards"}, cards),
    }))
   end
   table.insert(children, ui.el("div", {class="tdm-board-lanes"}, lanes))
  end
  return {main=ui.col({ui.el("div", {class="tdm-board-screen"}, children)})}
 end,
 key = function(state, key, cx)
  if key.name ~= "escape" then return false end
  screen.back(state.origin, cx); return true
 end,
 event = function(state, ev, cx)
  if ev.ev ~= "action" then return end
  if ev.act == "back" then screen.back(state.origin, cx)
  elseif ev.act == "pr" and state.view.status == "ready" and state.view.model then
   for _, lane in state.view.model.board.lanes do for _, card in lane.cards do
    if card.key == ev.value and card.pullRequest then rt.act(cx, state.origin, {verb = "board-link", cardKey = card.key}); return end
   end end
  end
 end,
 save = function(state) return {args=state.args} end,
}
return block
