--!strict
-- Wire shapes only. TypeScript owns the projection and review policy.
local M = {}
local views = require("./view-file")
export type TaskIndex = { pullRequests: { [string]: { header: { taskId: string? }, detailFile: string } } }
export type Index = { pullRequests: { [string]: { header: { number: number, title: string, taskId: string?, repo: string }, detailFile: string } } }
export type Comment = { id: string, databaseId: number?, author: string, at: string, body: string, url: string? }
export type Thread = { id: string, file: string, line: number?, side: string, resolved: boolean, outdated: boolean, comments: { Comment } }
export type Draft = { id: string, file: string, line: number, severity: string, body: string }
export type Row = { id: string, row: { kind: string, text: string?, old: number?, new: number?, oldStart: number?, newStart: number?, label: string? }, threads: { Thread }, drafts: { Draft } }
export type File = { path: string, additions: number, deletions: number, commentCount: number, rows: { Row } }
export type Model = {
 header: { repo: string, number: number, title: string, url: string, head: string, draft: boolean, next: string, taskId: string?, commits: number, additions: number, deletions: number, unresolved: number, firstThreadId: string? },
 readAt: string, tabs: { string }, checks: { { name: string, state: string, startedAtMs: number?, duration: string?, logUrl: string? } },
 description: { markdown: string, blocks: { string }, conversation: { Comment } },
 tour: { { title: string, why: string, stops: { { file: string, from: number, to: number, title: string, body: string, rowIds: { string } } } } },
 files: { File }, unanchoredThreads: { Thread }, commentDestination: string, readOnlyReason: string?,
 review: { taskId: string, generation: number, head: string, currentHead: string, posted: boolean, verdict: string?, intent: string, summary: string, drafts: { Draft }, concerns: { { title: string, detail: string, severity: string } }, notes: { string } }?,
}
local function comments(value: unknown): boolean
 if type(value) ~= "table" then return false end
 for _, c in value do
  if type(c) ~= "table" or type(c.id) ~= "string" or type(c.author) ~= "string" or type(c.at) ~= "string" or type(c.body) ~= "string" then return false end
 end
 return true
end
local function threads(value: unknown): boolean
 if type(value) ~= "table" then return false end
 for _, t in value do
  if type(t) ~= "table" or type(t.id) ~= "string" or type(t.file) ~= "string" or (t.line ~= nil and (type(t.line) ~= "number" or t.line < 1)) or (t.side ~= "LEFT" and t.side ~= "RIGHT") or type(t.resolved) ~= "boolean" or type(t.outdated) ~= "boolean" or not comments(t.comments) then return false end
 end
 return true
end
local function drafts(value: unknown): boolean
 if type(value) ~= "table" then return false end
 for _, d in value do
  if type(d) ~= "table" or type(d.id) ~= "string" or type(d.file) ~= "string" or type(d.line) ~= "number" or d.line < 1 or type(d.body) ~= "string" or type(d.severity) ~= "string" then return false end
 end
 return true
end
local function strings(value: unknown): boolean
 if type(value) ~= "table" then return false end
 for _, text in value do if type(text) ~= "string" then return false end end
 return true
end
function M.parse(value: unknown): Model?
 if type(value) ~= "table" or type(value.header) ~= "table" or type(value.readAt) ~= "string" then return nil end
 local h = value.header
 for _, name in {"repo", "title", "url", "head", "next"} do if type(h[name]) ~= "string" then return nil end end
 for _, name in {"number", "commits", "additions", "deletions", "unresolved"} do if type(h[name]) ~= "number" then return nil end end
 if type(h.draft) ~= "boolean" or (h.taskId ~= nil and type(h.taskId) ~= "string") then return nil end
 if type(value.description) ~= "table" or type(value.description.markdown) ~= "string" or type(value.description.blocks) ~= "table" or not comments(value.description.conversation) then return nil end
 for _, b in value.description.blocks do if type(b) ~= "string" then return nil end end
 if type(value.checks) ~= "table" or not strings(value.tabs) or type(value.tour) ~= "table" or type(value.files) ~= "table" or not threads(value.unanchoredThreads) then return nil end
 for _, check in value.checks do
  if type(check) ~= "table" or type(check.name) ~= "string" or not table.find({"passed", "running", "failed", "pending"}, check.state) or (check.startedAtMs ~= nil and (type(check.startedAtMs) ~= "number" or check.startedAtMs ~= check.startedAtMs or math.abs(check.startedAtMs) == math.huge)) or (check.duration ~= nil and type(check.duration) ~= "string") or (check.logUrl ~= nil and type(check.logUrl) ~= "string") then return nil end
 end
 for _, chapter in value.tour do
  if type(chapter) ~= "table" or type(chapter.title) ~= "string" or type(chapter.why) ~= "string" or type(chapter.stops) ~= "table" then return nil end
  for _, stop in chapter.stops do
   if type(stop) ~= "table" or type(stop.file) ~= "string" or type(stop.from) ~= "number" or type(stop.to) ~= "number" or stop.from < 1 or stop.to < stop.from or type(stop.title) ~= "string" or type(stop.body) ~= "string" or not strings(stop.rowIds) then return nil end
  end
 end
 for _, file in value.files do
  if type(file) ~= "table" or type(file.path) ~= "string" or type(file.rows) ~= "table" or type(file.commentCount) ~= "number" or type(file.additions) ~= "number" or type(file.deletions) ~= "number" then return nil end
  for _, r in file.rows do
   if type(r) ~= "table" or type(r.id) ~= "string" or type(r.row) ~= "table" or not threads(r.threads) or not drafts(r.drafts) then return nil end
   if not table.find({"hunk", "ctx", "add", "del"}, r.row.kind) then return nil end
   if r.row.kind == "hunk" then
    if type(r.row.oldStart) ~= "number" or type(r.row.newStart) ~= "number" or type(r.row.label) ~= "string" then return nil end
   elseif type(r.row.text) ~= "string" or (r.row.kind ~= "del" and (type(r.row.new) ~= "number" or r.row.new < 1)) or (r.row.kind ~= "add" and (type(r.row.old) ~= "number" or r.row.old < 1)) then return nil end
  end
 end
 if value.commentDestination ~= "worker" and value.commentDestination ~= "review" and value.commentDestination ~= "read-only" then return nil end
 if value.commentDestination == "review" then
  local r = value.review
  if type(r) ~= "table" or type(r.taskId) ~= "string" or type(r.generation) ~= "number" or type(r.head) ~= "string" or type(r.currentHead) ~= "string" or type(r.posted) ~= "boolean" or type(r.summary) ~= "string" or type(r.intent) ~= "string" or not drafts(r.drafts) or type(r.concerns) ~= "table" or not strings(r.notes) or r.head ~= h.head then return nil end
  for _, concern in r.concerns do
   if type(concern) ~= "table" or type(concern.title) ~= "string" or type(concern.detail) ~= "string" or type(concern.severity) ~= "string" then return nil end
  end
 end
 return value :: Model
end
function M.parseIndex(value: unknown): Index?
 if type(value) ~= "table" or type(value.pullRequests) ~= "table" then return nil end
 for _, pr in value.pullRequests do
  if type(pr) ~= "table" or type(pr.header) ~= "table" or type(pr.header.number) ~= "number" or type(pr.header.title) ~= "string" or type(pr.header.repo) ~= "string" or (pr.header.taskId ~= nil and type(pr.header.taskId) ~= "string") or type(pr.detailFile) ~= "string" then return nil end
 end
 return value :: Index
end

-- Follow the task association published by TypeScript, never a PR number from another repo.
function M.taskDetailPath(taskPath: string, taskId: string, index: TaskIndex): string?
 if string.sub(taskPath, 1, 1) ~= "/" then return nil end
 local parent = string.match(taskPath, "^(.*)/task%-[^/]+%.json$")
 if not parent then return nil end
 local file: string? = nil
 for _, pr in index.pullRequests do
  if pr.header.taskId == taskId then
   if file ~= nil or not string.match(pr.detailFile, "^pr%-[%w%%_.-]+%.json$") then return nil end
   file = pr.detailFile
  end
 end
 return if file then parent .. "/" .. file else nil
end

function M.forTask(taskPath: string, taskId: string, index: TaskIndex): views.View<Model>?
 local path = M.taskDetailPath(taskPath, taskId, index)
 if not path then return nil end
 local view = views.create(path, "pr", function(value: unknown): Model?
  local model = M.parse(value)
  return if model and model.header.taskId == taskId then model else nil
 end)
 views.refresh(view)
 return view
end

return M
