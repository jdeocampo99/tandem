--!strict
local ui = tern.ui
local models = require("./pr-model")
local diff = require("./diff-row")
local components = require("./components")
local fields = require("./text-field")
local M = {}
export type Yours = { id: string, file: string, line: number, body: string, rowId: string, sent: boolean }
export type State = { file: number, yours: { Yours }, editor: fields.Field?, target: { file: string, line: number, rowId: string }?, decisions: { [string]: string }, jump: string?, editorPath: string?, busy: boolean }
export type Send = (Yours, () -> ()) -> ()
function M.create(): State
 return { file = 1, yours = {}, decisions = {}, busy = false }
end
local function editable(model: models.Model, ready: boolean): boolean
 return ready and (model.commentDestination == "worker" and model.header.taskId ~= nil or model.review ~= nil and not model.review.posted and model.review.head == model.review.currentHead)
end
local function thread(t: models.Thread, action: string?): Node
 local children = {}
 for i, comment in t.comments do
  table.insert(children, diff.card("comment-" .. i, comment.author .. " · " .. comment.at, comment.body))
 end
 table.insert(children, ui.row({ components.text(if t.resolved then "✓ resolved" elseif t.outdated then "outdated" else "unresolved", "muted"), if action then components.button("Reply", action) else components.text("") }))
 return ui.col(children)
end
local function editor(s: State): Node
 return ui.el("div", {class="tdm-comment", key="editor"}, {
  components.text("you · now", "strong"),
  fields.node(s.editor :: fields.Field, "field", "Comment…"),
  ui.row({components.button(if s.busy then "Sending…" else "Comment", "pr-save", "accent"), components.button("Cancel", "pr-cancel")}),
 })
end
function M.rows(s: State, model: models.Model, file: models.File, ready: boolean, selected: { string }?, prefix: string?): Node
 local nodes = {}
 for index, entry in file.rows do
  if selected ~= nil and not table.find(selected, entry.id) then continue end
  local r = entry.row
  local cards = {}
  local can = editable(model, ready) and not s.busy
  local line = if r.kind == "del" then r.old else r.new
  local action = if can and line ~= nil and (model.commentDestination == "worker" or r.kind ~= "del") then "pr-line=" .. index else nil
  for ti, t in entry.threads do table.insert(cards, thread(t, if action then "pr-reply=" .. index .. ":" .. ti else nil)) end
  for _, draft in entry.drafts do
   local decision = s.decisions[draft.id] or "undecided"
   table.insert(cards, diff.card("draft-" .. draft.id, "Reviewer · " .. draft.severity, draft.body, if can then {
    components.button(if decision == "post" then "✓ Keep" else "Keep", "pr-keep=" .. draft.id, if decision == "post" then "success" else "muted"),
    components.button(if decision == "drop" then "✓ Drop" else "Drop", "pr-drop=" .. draft.id),
   } else {}))
  end
  for _, mine in s.yours do
   if mine.rowId == entry.id then table.insert(cards, diff.card(mine.id, "you · " .. (if mine.sent then "sent to worker" else "new"), mine.body)) end
  end
  if s.target ~= nil and s.target.rowId == entry.id and s.editor ~= nil then
   s.editorPath = (prefix or "main.content.diff.rows") .. ".r" .. index .. ".thread-" .. (#cards + 1) .. ".editor.field"
   table.insert(cards, editor(s))
  end
  if r.kind == "hunk" then
   table.insert(nodes, components.keyed(components.text("@@ -" .. tostring(r.oldStart) .. " +" .. tostring(r.newStart) .. " @@ " .. (r.label or ""), "muted"), "r" .. index))
  else
   table.insert(nodes, diff.row({ key = "r" .. index, kind = r.kind :: "add" | "del" | "ctx", old = r.old, new = r.new, code = r.text or "" }, action, cards))
  end
 end
 return ui.el("div", {class="tdm-pr-rows",key="rows"}, nodes)
end
function M.view(s: State, model: models.Model, ready: boolean, prefix: string?): Node
 local files = {}
 for index, file in model.files do
  table.insert(files, components.button(file.path .. (if file.commentCount > 0 then " ●" .. file.commentCount else ""), "pr-file=" .. index, if s.file == index then "accent" else "muted"))
 end
 local file = model.files[s.file] or model.files[1]
 local nodes = { components.keyed(ui.row(files), "files") }
 if file then
  table.insert(nodes, components.text("+" .. file.additions .. " −" .. file.deletions .. " · " .. file.path, "muted"))
  table.insert(nodes, M.rows(s, model, file, ready, nil, (prefix or "main.content") .. ".diff.rows"))
 else table.insert(nodes, components.text("No text diff available", "muted")) end
 if #model.unanchoredThreads > 0 then
  table.insert(nodes, ui.rule("Other threads (outside this diff)"))
  for i, t in model.unanchoredThreads do table.insert(nodes, components.keyed(thread(t, nil), "other" .. i)) end
 end
 table.insert(nodes, components.text(if model.commentDestination == "worker" then "Hover a line and click + to comment. Your comments go to the worker as fix requests." else "Keep or drop reviewer drafts. Your new comments are included when you Post.", "muted"))
 return components.keyed(ui.col(nodes), "diff")
end
function M.jump(s: State, model: models.Model, cx: BlockCx, prefix: string)
 local id = model.header.firstThreadId
 if id == nil then return end
 for fi, file in model.files do
  for ri, row in file.rows do
   for _, t in row.threads do
    if t.id == id then
     s.file = fi
     cx:render()
     tern.timer(1, function() cx:frame({ { "reveal", prefix .. ".diff.rows.r" .. ri, "start" } }) end)
     return
    end
   end
  end
 end
 for i, t in model.unanchoredThreads do
  if t.id == id then cx:render(); tern.timer(1, function() cx:frame({ {"reveal", prefix .. ".diff.other" .. i, "start"} }) end); return end
 end
end
function M.event(s: State, model: models.Model, ready: boolean, ev: UiEvent, cx: BlockCx, send: Send): boolean
 if ev.ev == "focus" then return true end
 if ev.ev ~= "action" then return false end
 local act, value = ev.act, ev.value
 if act == "pr-file" then s.file = tonumber(value) or 1; return true end
 if not editable(model, ready) or s.busy then return false end
 if act == "pr-line" or act == "pr-reply" then
  local index = tonumber(string.match(value or "", "^%d+"))
  local file = model.files[s.file]
  local row = if file and index then file.rows[index] else nil
  if not row then return false end
  local line = if row.row.kind == "del" then row.row.old else row.row.new
  if not line or (model.commentDestination == "review" and row.row.kind == "del") then return false end
  s.target = { file = file.path, line = line, rowId = row.id }
  s.editor = fields.create("", true)
  cx:render()
  tern.timer(1, function()
   if s.editorPath then cx:frame({ {"reveal", s.editorPath, "nearest"}, {"focus", s.editorPath} }) end
  end)
  return true
 elseif act == "pr-cancel" then s.editor, s.target = nil, nil; return true
 elseif act == "pr-save" then
  if not s.editor or not s.target or not string.find(s.editor.text, "%S") then return false end
  local mine: Yours = { id = "you-" .. (#s.yours + 1), file = s.target.file, line = s.target.line, rowId = s.target.rowId, body = s.editor.text, sent = false }
  if model.commentDestination == "review" then
   table.insert(s.yours, mine); s.editor, s.target = nil, nil
  else
   s.busy = true
   send(mine, function() mine.sent = true; table.insert(s.yours, mine); s.editor, s.target = nil, nil end)
  end
  return true
 elseif act == "pr-keep" or act == "pr-drop" then
  if model.review then
   for _, draft in model.review.drafts do if draft.id == value then s.decisions[value] = if act == "pr-keep" then "post" else "drop"; return true end end
  end
 end
 return false
end
function M.key(s: State, model: models.Model, ready: boolean, key: Key, cx: BlockCx, send: Send): boolean
 if not s.editor or not editable(model, ready) or s.busy then return false end
 local outcome = fields.key(s.editor, key)
 if outcome == "submit" then return M.event(s, model, ready, {ev="action", act="pr-save"}, cx, send) end
 if outcome == "cancel" then s.editor, s.target = nil, nil end
 return outcome ~= "ignored"
end
return M
