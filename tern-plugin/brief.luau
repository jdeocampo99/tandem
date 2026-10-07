--!strict
local ui = tern.ui
local fields = require("./text-field")
local rows = require("./diff-row")
local components = require("./components")
local rt = require("./rt")

type Approval = { briefRevision: number, contentDigest: string, agreementDigest: string }
type Comment = { id: string, body: string, author: string }
type Line = { id: string, number: number, kind: string, text: string, isNew: boolean, comments: { Comment } }
type Brief = {
 requestId: string, title: string, revision: number, changes: number, approval: Approval,
 approvalState: string, abandoned: boolean, lines: { Line }, commentCount: number, browserUrl: string?,
}
type Draft = { lineId: string, text: string }
type State = {
 file: rt.Watch, shown: Brief?, shownSeq: number?, origin: rt.Origin,
 comments: { Draft }, editing: string?, editor: fields.Field, overall: fields.Field, active: string,
 submitted: boolean, notice: string?,
}

-- A refreshed file never reattaches a user's pending comments to a later draft.
local function sync(state: State)
 local file = state.file
 -- A draft that failed to draw was never shown; fall back to the one that did.
 if file.rejected ~= nil and state.shownSeq == file.rejected then state.shown, state.shownSeq = file.model, nil end
 if file.status ~= "ready" then return end
 if state.shown == nil or (#state.comments == 0 and state.editing == nil and state.overall.text == "" and not state.origin.busy and not state.submitted) then
  state.shown, state.shownSeq = file.model, file.seq
 end
end

local function saveComment(state: State)
 local line = state.editing
 if line == nil or not string.find(state.editor.text, "%S") then return end
 table.insert(state.comments, { lineId = line, text = state.editor.text })
 state.editing = nil
 state.editor = fields.create(nil, true)
 state.active = "overall"
end

local function submit(state: State, cx: BlockCx, verb: string)
 if state.origin.busy or state.submitted then return end
 local model = state.shown
 if state.file.status ~= "ready" or not model or model.abandoned then
  cx:toast("error", "Brief unavailable", "Wait for a readable brief before sending an action.")
  return
 end
 if state.editing then
  cx:toast("warning", "Finish your line comment", "Choose Comment or Cancel before submitting the brief.")
  return
 end
 if verb == "brief-request-changes" and #state.comments == 0 and not string.find(state.overall.text, "%S") then
  cx:toast("warning", "Add a comment", "Explain what should change before requesting changes.")
  return
 end
 if state.origin.ctx == "" then
  cx:toast("error", "Missing Tandem context", "Reopen the brief from the project's panel.")
  return
 end
 local approval = model.approval
 local action = if verb == "brief-approve" then {
  verb = verb, requestId = model.requestId, briefRevision = approval.briefRevision,
  contentDigest = approval.contentDigest, agreementDigest = approval.agreementDigest,
 } else {
  verb = verb, requestId = model.requestId, briefRevision = approval.briefRevision,
  contentDigest = approval.contentDigest, agreementDigest = approval.agreementDigest,
  comments = tern.json.array(state.comments),
  text = if string.find(state.overall.text, "%S") then state.overall.text else nil,
 }
 rt.act(cx, state.origin, action, function(outcome)
  if outcome == nil or outcome.status == "refused" then
   pcall(function() cx:render() end)
   return
  end
  state.submitted = true
  state.notice = if outcome.notice then outcome.notice.text else "This action completed. You can close this pane."
  -- The CLI owns guarded native closure; a retained pane must not offer the action again.
  -- A pane already retired by the CLI has no UI left to update.
  pcall(function() cx:render() end)
 end, rt.BRIEF)
end

local brief: BlockDef<State> = {
 init = function(cx, args)
  local state: State = {
   file = rt.watch(cx, args[1] or "", "brief"), origin = rt.origin(args),
   comments = {}, editor = fields.create(nil, true), overall = fields.create(), active = "overall", submitted = false,
  }
  sync(state)
  return state
 end,
 title = function(state) return if state.shown then "Brief · " .. state.shown.title else "Brief" end,
 view = function(state)
  sync(state)
  local model = state.shown
  if not model then return { main = ui.col({
   ui.el("div", { class = "brief-header" }, { components.text("Brief", "strong"), components.button("×", "close") }),
   ui.el("div", { class = "brief-document" }, { components.text("Loading brief… Waiting for a published revision.", "muted") }),
  }) } end
  local document: { Node } = {}
  if state.notice then table.insert(document, components.text(state.notice, "warn")) end
  if state.file.status ~= "ready" then
   table.insert(document, components.text("Brief unavailable. Actions are disabled until the view file recovers.", "warn"))
  elseif state.shownSeq ~= state.file.seq then
   local refreshed: {Node} = { components.text("A newer revision is available. Your comments still describe this revision.", "warn") }
   if not state.submitted then table.insert(refreshed, components.button("Discard comments and refresh", "refresh")) end
   table.insert(document, ui.row(refreshed))
  end
  if model.abandoned then table.insert(document, components.text("This request was abandoned.", "warn")) end
  for _, line in model.lines do
   local cards: { Node } = {}
   for _, comment in line.comments do table.insert(cards, rows.card(comment.id, comment.author, comment.body)) end
   for index, comment in state.comments do
    if comment.lineId == line.id then table.insert(cards, rows.card("draft-" .. index, "you · pending", comment.text, { components.button("Remove", "remove=" .. index) })) end
   end
   if state.editing == line.id then
    table.insert(cards, ui.el("div", { class = "tdm-comment" }, {
     components.text("you", "strong"), fields.node(state.editor, "comment", "Comment on this line…"),
     ui.row({ components.button("Comment", "comment", "accent"), components.button("Cancel", "cancel") }),
    }))
   end
   local row = rows.row({ key = line.id, new = line.number, code = (if line.kind == "item" then "• " else "") .. line.text, kind = "ctx" }, "add=" .. line.id, cards)
   local props = row.p or {}
   props.class = "tdm-diff-row tdm-ctx brief-row brief-" .. line.kind .. (if #cards > 0 then " brief-annotated" else "")
   row.p = props
   -- Keep the shared row/card implementation, placing the brief's hover button in its gutter.
   if row.c and row.c[1] and row.c[1].c then
    local cells = row.c[1].c
    local plus = cells[4]
    local code = cells[3]
    if plus and code then row.c[1].c = { plus, code } end
    if line.isNew then table.insert(row.c[1].c, ui.el("span", { class = "brief-new", text = "NEW" })) end
   end
   table.insert(document, row)
  end
  local count = model.commentCount + #state.comments
  local actions: { Node } = { components.text(tostring(count) .. (if count == 1 then " comment" else " comments"), "strong"), fields.node(state.overall, "overall", "Overall comment (optional)") }
  if state.file.status == "ready" and not model.abandoned and not state.origin.busy and not state.submitted then
   table.insert(actions, components.button("Approve", "approve", "success"))
   table.insert(actions, components.button("Request changes (" .. #state.comments .. ")", "changes"))
  elseif state.origin.busy then table.insert(actions, components.text("Sending…", "muted")) end
  local header = {
   components.text("Brief · " .. model.title .. " · rev " .. model.revision .. " · " .. model.changes .. " changes", "strong"),
   components.button("×", "close"),
  }
  if model.browserUrl then table.insert(header, components.button("Edit in browser ↗", "browser")) end
  return { main = ui.col({ ui.el("div", { class = "brief-header" }, header), ui.el("div", { class = "brief-document", key = "document" }, document) }), dock = ui.col({ ui.el("div", { class = "brief-bottom" }, actions) }) }
 end,
 key = function(state, key, cx)
  if state.origin.busy or state.submitted then return false end
  local field = if state.active == "comment" then state.editor else state.overall
  local outcome = fields.key(field, key)
  if outcome == "ignored" then return false end
  if outcome == "submit" and state.active == "comment" then saveComment(state)
  elseif outcome == "cancel" then state.editing = nil; state.active = "overall"
  elseif outcome == "next" then
   state.active = if state.active == "comment" then "overall" elseif state.editing then "comment" else "overall"
   cx:frame({ { "focus", "main." .. state.active } })
  end
  return true
 end,
 event = function(state, ev, cx)
  if ev.ev == "focus" then
   state.active = if ev.id and string.match(ev.id, "comment$") then "comment" else "overall"
   cx:frame({ { "focus", ev.id } })
   return
  end
  if ev.ev ~= "action" or state.origin.busy then return end
  if state.submitted and ev.act ~= "close" and ev.act ~= "browser" then return end
  if ev.act == "add" then
   if state.editing and state.editor.text ~= "" then cx:toast("warning", "Finish your line comment", "Choose Comment or Cancel first."); return end
   state.editing = ev.value; state.editor = fields.create(nil, true); state.active = "comment"
   cx:render(); cx:frame({ { "focus", "main.comment" } })
  elseif ev.act == "comment" then saveComment(state)
  elseif ev.act == "cancel" then state.editing = nil; state.active = "overall"
  elseif ev.act == "remove" then local index = tonumber(ev.value); if index then table.remove(state.comments, index) end
  elseif ev.act == "refresh" then
   state.comments = {}; state.editing = nil; state.overall = fields.create(); state.shown = nil; sync(state)
  elseif ev.act == "approve" then submit(state, cx, "brief-approve")
  elseif ev.act == "changes" then submit(state, cx, "brief-request-changes")
  elseif ev.act == "browser" then if state.shown and state.shown.browserUrl then cx:open(state.shown.browserUrl) end
  elseif ev.act == "close" then cx:exit(0)
  end
 end,
 -- Comment drafts remain transient and never write durable Tandem state.
 save = function() return {} end,
}
return brief
