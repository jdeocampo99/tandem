--!strict
-- Wire shapes only. TypeScript owns the projection and review policy.
local M = {}
export type Comment = { id: string, author: string, at: string, body: string, url: string? }
export type Thread = { id: string, file: string, line: number?, side: string, resolved: boolean, outdated: boolean, comments: { Comment } }
export type Draft = { id: string, file: string, line: number, severity: string, body: string }
export type Row = { id: string, row: { kind: string, text: string?, old: number?, new: number?, oldStart: number?, newStart: number?, label: string? }, threads: { Thread }, drafts: { Draft } }
export type File = { path: string, additions: number, deletions: number, commentCount: number, rows: { Row } }
export type Model = {
 header: { repo: string, number: number, title: string, url: string, head: string, draft: boolean, next: string, taskId: string?, commits: number, additions: number, deletions: number, unresolved: number, firstThreadId: string? },
 readAt: string, tabs: { string }, checks: { { name: string, state: string, elapsedMs: number?, duration: string?, logUrl: string? } },
 description: { markdown: string, blocks: { string }, conversation: { Comment } },
 tour: { { title: string, why: string, stops: { { file: string, from: number, to: number, title: string, body: string, rowIds: { string } } } } },
 files: { File }, unanchoredThreads: { Thread }, commentDestination: string,
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
function M.parse(value: unknown): Model?
 if type(value) ~= "table" or type(value.header) ~= "table" or type(value.readAt) ~= "string" then return nil end
 local h = value.header
 for _, name in {"repo", "title", "url", "head", "next"} do if type(h[name]) ~= "string" then return nil end end
 for _, name in {"number", "commits", "additions", "deletions", "unresolved"} do if type(h[name]) ~= "number" then return nil end end
 if type(h.draft) ~= "boolean" or (h.taskId ~= nil and type(h.taskId) ~= "string") then return nil end
 if type(value.description) ~= "table" or type(value.description.markdown) ~= "string" or type(value.description.blocks) ~= "table" or not comments(value.description.conversation) then return nil end
 for _, b in value.description.blocks do if type(b) ~= "string" then return nil end end
 if type(value.checks) ~= "table" or type(value.tabs) ~= "table" or type(value.tour) ~= "table" or type(value.files) ~= "table" or not threads(value.unanchoredThreads) then return nil end
 for _, check in value.checks do
  if type(check) ~= "table" or type(check.name) ~= "string" or not table.find({"passed", "running", "failed", "pending"}, check.state) then return nil end
 end
 for _, file in value.files do
  if type(file) ~= "table" or type(file.path) ~= "string" or type(file.rows) ~= "table" or type(file.commentCount) ~= "number" then return nil end
  for _, r in file.rows do
   if type(r) ~= "table" or type(r.id) ~= "string" or type(r.row) ~= "table" or not threads(r.threads) or type(r.drafts) ~= "table" then return nil end
   if not table.find({"hunk", "ctx", "add", "del"}, r.row.kind) then return nil end
  end
 end
 if value.commentDestination ~= "worker" and value.commentDestination ~= "review" then return nil end
 if value.commentDestination == "review" then
  local r = value.review
  if type(r) ~= "table" or type(r.taskId) ~= "string" or type(r.generation) ~= "number" or type(r.head) ~= "string" or type(r.currentHead) ~= "string" or type(r.posted) ~= "boolean" or type(r.summary) ~= "string" or type(r.intent) ~= "string" or type(r.drafts) ~= "table" or type(r.concerns) ~= "table" or type(r.notes) ~= "table" then return nil end
 end
 return value :: Model
end
return M
