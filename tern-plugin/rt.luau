--!strict
-- The one way a click reaches Tandem: an `ActionEnvelope` (src/native/contract.ts) on the stdin of
-- `tandem native act`, answered by one `Outcome`. No durable state, no retries. `watch` and `draw`
-- are the one way a block reads and shows a view file.
local M = {}

-- A block's origin echoes the context it was launched with; Luau never reads `ctx`.
-- A window command's origin is the pane focused at the gesture. `busy` holds one action at a time.
export type Origin = {ctx: string?, pane: number?, cwd: string?, window: string?, busy: boolean}
export type Notice = {code: string, text: string}
export type Outcome = {status: string, notice: Notice?}
-- Toast titles for a refusal or a failed launch; a missing title keeps that failure silent.
export type Labels = {refused: string?, start: string?}

M.ACTION = {refused = "Tandem couldn't run that action", start = "Tandem couldn't start that action"} :: Labels
M.TASK = {refused = "Tandem action failed", start = "Tandem action could not start"} :: Labels
M.PR = {refused = "PR action failed", start = "PR action could not start"} :: Labels
M.BRIEF = {refused = "Tandem couldn't send the brief", start = "Tandem couldn't start that action"} :: Labels
M.PICKER = {refused = "Task could not open", start = "Task could not open"} :: Labels
M.SETUP = {refused = "Tandem couldn't save your setup", start = "Tandem couldn't start saving your setup"} :: Labels
M.QUIET = {} :: Labels

local NOTICES: {[string]: {level: string, title: string}} = {
 ["view-kept"] = {level = "warning", title = "Tandem kept an uncertain view"},
 ["catch-up-unavailable"] = {level = "warning", title = "Tandem action completed"},
 ["brief-warning"] = {level = "warning", title = "Brief action completed"},
 ["brief-left-open"] = {level = "warning", title = "Brief left open"},
 ["review-posted"] = {level = "info", title = "Review posted"},
 ["review-unconfirmed"] = {level = "info", title = "Review wasn't confirmed as posted"},
 ["feedback-saved"] = {level = "warning", title = "PR feedback saved"},
 ["setup-incomplete"] = {level = "warning", title = "Setup saved with problems"},
}

-- One view file a block draws (src/native/contract.ts `ViewFile`). `model` is the newest file
-- accepted, `status` whether the file on disk is still that one. A file is accepted only when its
-- `seq` is higher than the shown one; a new `epoch` is a new store, so its first file is accepted.
export type Watch = {
 path: string, kind: string, status: "waiting" | "ready" | "unavailable", model: any, good: any,
 seq: number, epoch: string?, raw: string?, rejected: number?, stopped: boolean, pending: TimerHandle?,
}

local watching: {[number]: {Watch}} = {}

local function refresh(w: Watch): boolean
 local before = w.status
 local ok, raw = pcall(tern.fs.read, w.path, 8 * 1024 * 1024)
 if not ok then
  w.raw, w.status = nil, "unavailable"
  return before ~= w.status
 end
 if raw == w.raw then return false end
 w.raw = raw
 local decoded, file = pcall(tern.json.decode, raw)
 if not decoded or type(file) ~= "table" or file.v ~= 1 or file.kind ~= w.kind or type(file.epoch) ~= "string"
  or type(file.seq) ~= "number" or type(file.model) ~= "table" then
  w.status = "unavailable"
  return before ~= w.status
 end
 if file.epoch == w.epoch and file.seq <= w.seq then
  if file.seq == w.seq and w.rejected ~= file.seq then w.status = "ready" end
  return before ~= w.status
 end
 w.epoch, w.seq, w.model, w.status = file.epoch, file.seq, file.model, "ready"
 return true
end

local function forget(pane: number, w: Watch)
 local list = watching[pane]
 if not list then return end
 local at = table.find(list, w)
 if at then table.remove(list, at) end
 if #list == 0 then watching[pane] = nil end
end

-- Reads `path` now, then once a second while the block's pane is live.
function M.watch(cx: BlockCx, path: string, kind: string): Watch
 local w: Watch = {path = path, kind = kind, status = "waiting", seq = 0, stopped = false}
 refresh(w)
 local list = watching[cx.pane] or {}
 watching[cx.pane] = list
 table.insert(list, w)
 local pane = cx.pane
 local function tick()
  if w.stopped then return end
  local live = false
  for _, listed in tern.pane.list() do if listed.pane == pane then live = true; break end end
  if not live then forget(pane, w); return end
  if refresh(w) then cx:render() end
  w.pending = tern.timer(1000, tick)
 end
 -- The pane is listed only after init returns, so polling starts in a timer.
 w.pending = tern.timer(1, tick)
 return w
end

function M.unwatch(cx: BlockCx, w: Watch)
 w.stopped = true
 if w.pending then w.pending:cancel() end
 forget(cx.pane, w)
end

-- Draws a block. A model that fails to draw is never shown: its watch goes back to the last model
-- that drew, marked unavailable, until a newer file arrives.
function M.draw<S>(view: (S, BlockCx) -> View, state: S, cx: BlockCx): View
 local ok, result = pcall(view, state, cx)
 local list = watching[cx.pane] or {}
 if ok then
  for _, w in list do w.good = w.model end
  return result
 end
 local reverted = false
 for _, w in list do
  if w.model ~= w.good then
   w.model, w.status, w.rejected = w.good, "unavailable", w.seq
   reverted = true
  end
 end
 if not reverted then error(result, 0) end
 return M.draw(view, state, cx)
end

function M.origin(args: {string}): Origin
 return {ctx = args[2] or "", busy = false}
end

local function decode(stdout: string): Outcome?
 local ok, value = pcall(function() return tern.json.decode(stdout) end)
 if not ok or type(value) ~= "table" or type(value.status) ~= "string" then return nil end
 local notice = value.notice
 if notice ~= nil and (type(notice) ~= "table" or type(notice.code) ~= "string" or type(notice.text) ~= "string") then return nil end
 return value :: Outcome
end

local function show(cx: BlockCx | WindowCx, result: {status: number, stdout: string, stderr: string}, labels: Labels): Outcome?
 local outcome = if result.status == 0 then decode(result.stdout) else nil
 if not outcome then
  if labels.refused then
   cx:toast("error", labels.refused, if result.status ~= 0 then result.stderr else "Tandem returned no outcome for that action.")
  end
  return nil
 end
 local notice = outcome.notice
 if notice then
  local known = NOTICES[notice.code]
  if known then cx:toast(known.level, known.title, notice.text)
  elseif labels.refused then cx:toast("error", labels.refused, notice.text) end
 end
 return outcome
end

-- Sends `action` from `origin` and calls `done` with the outcome, or nil when none arrived.
-- Returns false without sending while the origin's previous action is still running.
function M.act(cx: BlockCx | WindowCx, origin: Origin, action: {[string]: unknown}, done: ((Outcome?, BlockCx | WindowCx) -> ())?, labels: Labels?): boolean
 if origin.busy then return false end
 local shown = labels or M.ACTION
 local from = if origin.ctx then {pane = string.format("%.0f", (cx :: BlockCx).pane), ctx = origin.ctx}
  else {pane = string.format("%.0f", origin.pane :: number), cwd = origin.cwd, window = origin.window}
 local stdin = tern.json.encode({v = 1, origin = from, action = action})
 local argv = {"/bin/sh", "tandem.sh", "native", "act"}
 origin.busy = true
 local function settle(resultCx: BlockCx | WindowCx, result: {status: number, stdout: string, stderr: string})
  origin.busy = false
  local outcome = show(resultCx, result, shown)
  if done then done(outcome, resultCx) end
 end
 local function failed(launchCx: BlockCx | WindowCx, problem: unknown)
  origin.busy = false
  if shown.start then launchCx:toast("error", shown.start, tostring(problem)) end
  if done then done(nil, launchCx) end
 end
 if origin.ctx then
  local ok, problem = pcall(function()
   tern.process.run(argv, {cwd = ".", stdin = stdin}, function(result) settle(cx, result) end)
  end)
  if not ok then failed(cx, problem) end
  return true
 end
 -- Window contexts never survive their callbacks: launch and handle the result in fresh timers.
 tern.timer(1, function(launchCx)
  if not launchCx then origin.busy = false; return end
  local ok, problem = pcall(function()
   tern.process.run(argv, {cwd = ".", stdin = stdin}, function(result)
    tern.timer(1, function(resultCx)
     if resultCx then settle(resultCx, result) else origin.busy = false end
    end)
   end)
  end)
  if not ok then failed(launchCx, problem) end
 end)
 return true
end

return M
