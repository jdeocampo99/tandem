--!strict
-- Shapes the PR screens draw; src/native/contract.ts validates them. TypeScript owns the projection
-- and review policy.
local M = {}
local rt = require("./rt")
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

function M.forTask(cx: BlockCx, taskPath: string, taskId: string, index: TaskIndex): rt.Watch?
 local path = M.taskDetailPath(taskPath, taskId, index)
 return if path then rt.watch(cx, path, "pr") else nil
end

return M
