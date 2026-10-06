--!strict
-- Window routing only. The CLI owns state, project lookup, opening views, and every action guard.
local rt = require("./rt")

local function run(cx: WindowCx, action: {[string]: unknown})
 local origin = rt.focused(cx)
 if not origin then
  cx:toast("error", "Tandem couldn't run that action", "The originating pane and its absolute cwd are required.")
  return
 end
 rt.act(cx, origin, action)
end

local function command(id: string, title: string, action: {[string]: unknown}, palette: boolean?)
 tern.command({ id = id, title = title,
  available = if palette == false then function() return false end else nil,
  run = function(cx) run(cx, action) end })
end

command("new-request", "Tandem: New request…", {verb = "open", ref = {kind = "new-request"}})
command("open-task", "Tandem: Open task…", {verb = "open", ref = {kind = "task-picker"}})
command("board", "Tandem: Toggle board", {verb = "open", ref = {kind = "board"}})
command("prs", "Tandem: Show PRs", {verb = "open", ref = {kind = "prs"}})
command("usage", "Tandem: Usage", {verb = "open", ref = {kind = "usage"}})

for number = 1, 9 do
 command("project-" .. tostring(number), "Tandem: Project " .. tostring(number), {verb = "project", target = number}, false)
end
command("project-prev", "Tandem: Previous project", {verb = "project", target = "prev"}, false)
command("project-next", "Tandem: Next project", {verb = "project", target = "next"}, false)

-- `nativeLink` in src/native/contract.ts writes these; PR links carry a number only.
tern.route.link(function(link, cx)
 local kind, id = string.match(link.url, "^tandem://([a-z]+)/([%w_-]+)$")
 if kind == "task" and id then run(cx, {verb = "open", ref = {kind = "task", taskId = id}})
 elseif kind == "brief" and id then run(cx, {verb = "open", ref = {kind = "brief", requestId = id}})
 elseif kind == "pr" and id and string.match(id, "^%d+$") then run(cx, {verb = "open", ref = {kind = "pr", number = tonumber(id)}})
 else return nil end
 return { handled = true }
end)

tern.route.open(function(req, cx)
 if string.match(req.path, "/native%-host/%x+%.[%x%-]+%.ticket%.json$") then
  local path=req.path
  tern.timer(1,function(loadCx)
   if not loadCx then return end
   local loaded,host=pcall(function() return require("./layout") end)
   tern.timer(1,function(openCx)
    if not openCx then return end
    if loaded then host.open({path=path},openCx)
    else openCx:toast("error","Tandem view did not open",tostring(host)) end
   end)
  end)
  return {handled=true}
 end
 return nil
end)

-- Lifecycle context carries only the pane/cwd. The CLI proves project/session ownership,
-- redirects the recorded alert helper, and owns all visit/read-cursor policy.
local previous: rt.Origin? = nil
local queue: {{origin: rt.Origin, event: string}} = {}
local busy = false
local head, tail = 1, 0
local function enqueue(origin: rt.Origin, event: string)
 tail += 1; queue[tail] = {origin = origin, event = event}
end
local function drain(cx: WindowCx)
 if busy or head > tail then return end
 busy = true
 local job = queue[head]
 queue[head] = nil; head += 1
 if head > tail then head, tail = 1, 0 end
 -- A fresh origin per job: the transport's busy flag must not hold back the FIFO.
 local origin = {pane = job.origin.pane, cwd = job.origin.cwd, window = job.origin.window, busy = false}
 rt.act(cx, origin, {verb = "visit", event = job.event}, function(_outcome, callbackCx)
  busy = false
  drain(callbackCx :: WindowCx)
 end, rt.QUIET)
end
local function enter(cx: WindowCx)
 local next = rt.focused(cx)
 if previous and next and previous.pane == next.pane then return end
 if previous then enqueue(previous, "away") end
 previous = next
 if next then enqueue(next, "entry") end
 drain(cx)
end
tern.on("focus", function(_ev: FocusEvent, cx: WindowCx) enter(cx) end)
local function pulse()
 tern.timer(60000, function(cx)
  if cx then
   local origin = rt.focused(cx)
   if origin then enqueue(origin, "visible"); drain(cx) end
  end
  pulse()
 end)
end
tern.on("window_start", function(cx: WindowCx) enter(cx); pulse() end)
