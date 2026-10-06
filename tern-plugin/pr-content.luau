--!strict
local ui = tern.ui
local models = require("./pr-model")
local components = require("./components")
local fields = require("./text-field")
local diff = require("./pr-diff")
local M = {}
export type State = { tab: string, chapter: number, stop: number, diff: diff.State, summary: fields.Field?, verdict: string, head: string?, generation: number?, clock: number, readAt: string?, posting: boolean, submitted: boolean, focus: string, prefix: string, identity: string? }
export type Invoke = (string, string, unknown?, (() -> ())?) -> ()
function M.create(): State
 return { tab = "Description", chapter = 1, stop = 1, diff = diff.create(), verdict = "comment", clock = tern.now(), posting = false, submitted = false, focus = "comment", prefix = "main.content" }
end
local function identity(model: models.Model): string
 return model.header.repo .. "#" .. model.header.number .. ":" .. (model.header.taskId or "") .. ":" .. model.commentDestination
end
function M.ready(s: State, model: models.Model, ready: boolean): boolean
 return ready and (s.identity == nil or s.identity == identity(model)) and (s.head == nil or s.head == model.header.head) and (model.review == nil or s.generation == nil or s.generation == model.review.generation)
end
local function bind(s: State, model: models.Model)
 if s.identity == nil then s.identity = identity(model) end
 if s.head == nil then s.head = model.header.head end
 if model.review and s.generation == nil then
  s.generation = model.review.generation
  s.summary = fields.create(model.review.summary, true)
 end
 if s.readAt ~= model.clockAt then s.clock = tern.now(); s.readAt = model.clockAt end
end
function M.view(s: State, model: models.Model, ready: boolean, prefix: string?, strip: Node?): { dock: Node, main: Node }
 s.prefix = prefix or "main.content"
 bind(s, model)
 local valid = M.ready(s, model, ready)
 local h = model.header
 local checks = {}
 for i, check in model.checks do
  local parts = {}
  if check.state == "running" then
   table.insert(parts, ui.node("spinner", {style="braille", label=check.name .. " · running"}))
   if check.elapsedMs ~= nil then table.insert(parts, ui.node("elapsed", {key="timer" .. i, age=check.elapsedMs + tern.now() - s.clock, format="clock"})) end
  elseif check.state == "passed" then table.insert(parts, ui.node("badge", {text="✓ " .. check.name .. (if check.duration then " · " .. check.duration else ""), tone="success"}))
  elseif check.state == "failed" then
   table.insert(parts, components.text("✗ " .. check.name, "danger"))
   if check.logUrl then table.insert(parts, components.button("view log", "pr-log=" .. i, "danger")) end
  else table.insert(parts, components.text(check.name .. " · pending", "muted")) end
  table.insert(checks, ui.row(parts))
 end
 local tabs = {}
 for _, tab in model.tabs do table.insert(tabs, components.button(tab, "pr-tab=" .. tab, if s.tab == tab then "accent" else "muted")) end
 if not table.find(model.tabs, s.tab) then s.tab = "Description" end
 local metadata = {
  if h.unresolved > 0 then components.button(h.unresolved .. " unresolved comments", "pr-unresolved", "warn") else components.text("no unresolved comments", "muted"),
  if h.taskId then components.button("task " .. h.taskId .. " ↗", "pr-task") else components.text(""),
  components.text(h.commits .. " commits · +" .. h.additions .. " −" .. h.deletions, "muted"),
 }
 local header = {
  ui.row({components.text("#" .. h.number .. " " .. h.title, "strong"), ui.node("badge", {text=if h.draft then "draft" else "open", tone="muted"}), components.button("Open PR ↗", "pr-url")}),
  components.text(h.next), ui.row(checks), ui.row(metadata), ui.row(tabs),
 }
 if strip then table.insert(header, 1, strip) end
 if not valid then table.insert(header, components.text("View changed or unavailable. Reopen this PR before sending comments or posting.", "warn")) end
 local body: Node
 if s.tab == "Diff" then body = diff.view(s.diff, model, valid, s.prefix .. ".body")
 elseif s.tab == "Tour" then
  local nodes = {}
  for ci, chapter in model.tour do
   table.insert(nodes, ui.rule(ci .. " · " .. chapter.title))
   table.insert(nodes, components.text(chapter.why, "muted"))
   for si, stop in chapter.stops do
    table.insert(nodes, components.button(stop.file .. ":" .. stop.from .. "–" .. stop.to .. " " .. stop.title .. ": " .. stop.body, "pr-stop=" .. ci .. ":" .. si, if ci == s.chapter and si == s.stop then "accent" else "muted"))
   end
  end
  local chapter = model.tour[s.chapter]
  local stop = if chapter then chapter.stops[s.stop] else nil
  if stop then
   for fi, file in model.files do
    if file.path == stop.file then s.diff.file = fi; table.insert(nodes, components.text(stop.file .. ":" .. stop.from .. "–" .. stop.to, "muted")); table.insert(nodes, diff.rows(s.diff, model, file, false, stop.rowIds)); break end
   end
  end
  body = components.keyed(ui.col(nodes), "tour")
 else
  local nodes = {}
  for index, block in model.description.blocks do table.insert(nodes, components.keyed(ui.md(block), "md" .. index)) end
  if model.review then
   table.insert(nodes, ui.rule("Review")); table.insert(nodes, ui.md(model.review.intent))
   if model.review.verdict then table.insert(nodes, components.text(model.review.verdict)) end
   for _, concern in model.review.concerns do table.insert(nodes, ui.card({ui.span(concern.title .. " · " .. concern.severity, "strong")}, {ui.md(concern.detail)})) end
   for _, note in model.review.notes do table.insert(nodes, components.text(note, "muted")) end
  end
  table.insert(nodes, ui.rule("Conversation"))
  for index, comment in model.description.conversation do
   table.insert(nodes, components.keyed(ui.card({ui.span(comment.author .. " · " .. comment.at, "strong")}, {ui.md(comment.body)}), "conversation" .. index))
  end
  if #model.description.conversation == 0 then table.insert(nodes, components.text("No conversation yet", "muted")) end
  body = components.keyed(ui.col(nodes), "description")
 end
 local main = {ui.el("div", {class="tdm-pr-header",key="header"}, header), ui.el("div", {class="tdm-pr-body",key="body"}, {body})}
 local footer = {}
 if model.review then
  local review = model.review
  local canPost = valid and not review.posted and review.head == review.currentHead and not s.posting and not s.submitted
  local buttons = {}
  for _, verdict in {"comment", "approve", "request-changes"} do
   table.insert(buttons, components.button((if s.verdict == verdict then "✓ " else "") .. verdict, "pr-verdict=" .. verdict, if s.verdict == verdict then "accent" else "muted"))
  end
  table.insert(footer, ui.rule("Your review"))
  if canPost then
   table.insert(footer, components.keyed(fields.node(s.summary :: fields.Field, "pr-summary", "Overall review…"), "pr-summary"))
   table.insert(buttons, components.button("Post", "pr-post", "accent"))
  else table.insert(footer, components.text(if review.posted or s.submitted then "Review already posted" elseif s.posting then "Posting…" else "PR changed or view unavailable. Re-review before posting.", "warn")) end
  table.insert(footer, ui.row(buttons))
  table.insert(footer, components.text("Reviewed commit " .. review.head .. " · Only drafts marked Keep and your new comments will be posted.", "muted"))
 end
 return {dock=ui.col(footer), main=ui.el("div", {class="tdm-pr-content",key="content"}, main)}
end
local function sender(s: State, model: models.Model, invoke: Invoke): diff.Send
 return function(mine, done)
  invoke("pr-comment", model.header.taskId :: string, { comments = tern.json.array({{file=mine.file,line=mine.line,text=mine.body}}) }, function() done() end)
 end
end
function M.event(s: State, model: models.Model, ready: boolean, ev: UiEvent, cx: BlockCx, invoke: Invoke): boolean
 if ev.ev == "focus" and ev.id then s.focus = if string.find(ev.id, "pr%-summary$") then "summary" else "comment" end
 local valid = M.ready(s, model, ready)
 if ev.ev == "action" then
  if ev.act == "pr-tab" and table.find(model.tabs, ev.value) then s.tab = ev.value; return true
  elseif ev.act == "pr-url" then cx:open(model.header.url); return true
  elseif ev.act == "pr-log" then local check = model.checks[tonumber(ev.value) or 0]; if check and check.logUrl then cx:open(check.logUrl) end; return true
  elseif ev.act == "pr-task" and model.header.taskId then invoke("open", "task", model.header.taskId); return true
  elseif ev.act == "pr-unresolved" then s.tab = "Diff"; diff.jump(s.diff, model, cx, s.prefix .. ".body"); return true
  elseif ev.act == "pr-stop" then local c, stop = string.match(ev.value or "", "^(%d+):(%d+)$"); s.chapter, s.stop = tonumber(c) or 1, tonumber(stop) or 1; return true
  elseif ev.act == "pr-verdict" and table.find({"comment", "approve", "request-changes"}, ev.value) and valid and model.review and not model.review.posted and not s.posting and not s.submitted then s.verdict = ev.value; return true
  elseif ev.act == "pr-post" and valid and model.review and not model.review.posted and model.review.head == model.review.currentHead and not s.posting and not s.submitted then
   local drafts = {}
   for _, d in model.review.drafts do table.insert(drafts, {id=d.id, decision=s.diff.decisions[d.id] or "undecided"}) end
   local yours = {}
   for _, mine in s.diff.yours do table.insert(yours, {file=mine.file,line=mine.line,body=mine.body}) end
   s.posting = true
   invoke("review-submit", model.review.taskId, {tandemPrReview=1,reviewHead=s.head,reviewGeneration=s.generation,verdict=s.verdict,summary=(s.summary :: fields.Field).text,drafts=tern.json.array(drafts),yours=tern.json.array(yours)}, function() s.submitted = true end)
   return true
  end
 end
 return diff.event(s.diff, model, valid, ev, cx, sender(s, model, invoke))
end
function M.key(s: State, model: models.Model, ready: boolean, key: Key, cx: BlockCx, invoke: Invoke): boolean
 if s.focus == "summary" and s.summary and M.ready(s, model, ready) and not s.posting and not s.submitted then return fields.key(s.summary, key) ~= "ignored" end
 return diff.key(s.diff, model, M.ready(s, model, ready), key, cx, sender(s, model, invoke))
end
return M
