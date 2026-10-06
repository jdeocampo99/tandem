--!strict
local views = require("./view-file")
local components = require("./components")
local screen = require("./screen")
local ui = tern.ui

type Card = { key: string, title: string, branch: string?, detail: string, time: string?, model: string?, costLabel: string?, harnessGlyph: string?, stuck: boolean, pullRequest: { number: number, draft: boolean, url: string }? }
type Lane = { title: string, count: number, cards: { Card } }
type Model = { project: string, board: { viewOnly: boolean, returnLabel: string, lanes: { Lane } } }
type State = { view: views.View<Model>, args: { string } }

local function parse(value: unknown): Model?
 if type(value) ~= "table" or type(value.project) ~= "string" or type(value.board) ~= "table" then return nil end
 local board = value.board
 if board.viewOnly ~= true or type(board.returnLabel) ~= "string" or type(board.lanes) ~= "table" or #board.lanes ~= 4 then return nil end
 for _, lane in board.lanes do
  if type(lane) ~= "table" or type(lane.title) ~= "string" or type(lane.count) ~= "number" or type(lane.cards) ~= "table" then return nil end
  for _, card in lane.cards do
   if type(card) ~= "table" or type(card.key) ~= "string" or type(card.title) ~= "string" or type(card.detail) ~= "string" or type(card.stuck) ~= "boolean" then return nil end
   for _, field in {"branch", "time", "model", "costLabel", "harnessGlyph"} do if card[field] ~= nil and type(card[field]) ~= "string" then return nil end end
   local pr = card.pullRequest
   if pr ~= nil and (type(pr) ~= "table" or type(pr.number) ~= "number" or type(pr.draft) ~= "boolean" or type(pr.url) ~= "string") then return nil end
  end
 end
 return value :: Model
end

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
  local state: State = {args=screen.args(args, saved), view=views.create(screen.path(args, saved), "panel", parse)}
  views.refresh(state.view); views.watch(state.view, cx)
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
  screen.back(state.args, cx, "board"); return true
 end,
 event = function(state, ev, cx)
  if ev.ev ~= "action" then return end
  if ev.act == "back" then screen.back(state.args, cx, "board")
  elseif ev.act == "pr" and state.view.status == "ready" and state.view.model then
   for _, lane in state.view.model.board.lanes do for _, card in lane.cards do
    if card.key == ev.value and card.pullRequest then screen.run(state.args, cx, {"board", "pr-link", card.key}); return end
   end end
  end
 end,
 save = function(state) return {args=state.args} end,
}
return block
