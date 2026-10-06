--!strict
-- The one way a click reaches Tandem: an `ActionEnvelope` (src/native/contract.ts) on the stdin of
-- `tandem native act`, answered by one `Outcome`. No durable state, no retries.
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
M.QUIET = {} :: Labels

local NOTICES: {[string]: {level: string, title: string}} = {
 ["view-kept"] = {level = "warning", title = "Tandem kept an uncertain view"},
 ["catch-up-unavailable"] = {level = "warning", title = "Tandem action completed"},
 ["brief-warning"] = {level = "warning", title = "Brief action completed"},
 ["brief-left-open"] = {level = "warning", title = "Brief left open"},
 ["review-posted"] = {level = "info", title = "Review posted"},
 ["review-unconfirmed"] = {level = "info", title = "Review wasn't confirmed as posted"},
}

function M.origin(args: {string}): Origin
 return {ctx = args[2] or "", busy = false}
end

-- The focused pane at the gesture, when it has an absolute cwd.
function M.focused(cx: WindowCx): Origin?
 local pane = cx.session:focused()
 local info = if pane then cx.session:pane(pane) else nil
 if not pane or not info or not info.cwd or string.sub(info.cwd, 1, 1) ~= "/" then return nil end
 local window = tern.getenv("TERN_WINDOW_KEY")
 return {pane = pane, cwd = info.cwd, window = if window and window ~= "" then window else nil, busy = false}
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
