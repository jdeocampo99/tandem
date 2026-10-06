--!strict
-- Derived files only. A failed read keeps the last model and disables revision-bound actions.
local M = {}
export type View<T> = {
 path: string, kind: string, raw: string?, revision: string?, model: T?,
 status: "waiting" | "ready" | "unavailable", parse: (unknown) -> T?,
}

function M.create<T>(path: string, kind: string, parse: (unknown) -> T?): View<T>
 return { path = path, kind = kind, status = "waiting", parse = parse }
end

-- A task, brief or PR detail file lives in the directory named after its project's index file.
function M.index(path: string): string
 for _, kind in {"task", "brief", "pr"} do
  local project = string.match(path, "^(.*)/" .. kind .. "%-[^/]*%.json$")
  if project then return project .. ".json" end
 end
 return path
end

function M.refresh<T>(state: View<T>): boolean
 local before = state.status
 local ok, raw = pcall(tern.fs.read, state.path, 8 * 1024 * 1024)
 if not ok then
  state.status = "unavailable"
  return before ~= state.status
 end
 if raw == state.raw and before == "ready" then return false end
 local decoded, value = pcall(tern.json.decode, raw)
 if decoded and type(value) == "table" and value.version == 1
  and value.kind == state.kind and type(value.revision) == "string" then
  local parsed, model = pcall(state.parse, value.model)
  if parsed and model ~= nil then
   local changed = state.raw ~= raw or before ~= "ready"
   state.raw, state.revision, state.model, state.status = raw, value.revision, model, "ready"
   return changed
  end
 end
 state.status = "unavailable"
 return before ~= state.status
end

-- Polling starts after init: the pane is not yet in tern.pane.list() inside init.
function M.watch<T>(state: View<T>, cx: BlockCx, interval: number?): () -> ()
 local stopped = false
 local pending: TimerHandle?
 local function tick()
  if stopped then return end
  local live = false
  for _, pane in tern.pane.list() do if pane.pane == cx.pane then live = true; break end end
  if not live then return end
  if M.refresh(state) then cx:render() end
  pending = tern.timer(interval or 1000, tick)
 end
 pending = tern.timer(1, tick)
 return function()
  stopped = true
  if pending then pending:cancel() end
 end
end

return M
