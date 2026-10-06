--!strict
-- Window routing only. The CLI owns state, project lookup, opening views, and every action guard.
type Origin={pane:number,cwd:string}
local function run(cx: WindowCx, args: { string }, origin:Origin?, quiet:boolean?, done:((cx:WindowCx)->())?)
 local argv = { "/bin/sh", "tandem.sh", "native" }
 for _, arg in args do table.insert(argv, arg) end
 local pane = if origin then origin.pane else cx.session:focused()
 local info = if pane then cx.session:pane(pane) else nil
 local cwd = if origin then origin.cwd else (if info then info.cwd else nil)
 if not pane or not cwd or string.sub(cwd, 1, 1) ~= "/" then
  if not quiet then cx:toast("error", "Tandem couldn't run that action", "The originating pane and its absolute cwd are required.") end
  if done then done(cx) end
  return
 end
 table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", pane))
 table.insert(argv, "--cwd"); table.insert(argv, cwd)
 local window = tern.getenv("TERN_WINDOW_KEY")
 if window and window ~= "" then table.insert(argv, "--window"); table.insert(argv, window) end
 -- Capture the gesture's origin now; launch in its own timer with a fresh context.
 tern.timer(1,function(launchCx)
  if not launchCx then return end
  local ok, problem = pcall(function()
   tern.process.run(argv, { cwd = "." }, function(result)
    -- Process hooks only enqueue. Cold helpers, result handling and the next launch
    -- each get their own timer stage rather than sharing the process hook budget.
    tern.timer(1,function(resultCx)
     if not resultCx then return end
     if result.status ~= 0 then
      if not quiet then resultCx:toast("error", "Tandem couldn't run that action", result.stderr) end
      if done then done(resultCx) end
     else
      local loaded,navigation=pcall(function() return require("./navigation") end)
      tern.timer(1,function(warningCx)
       if not warningCx then return end
       if loaded then
        local warnings=navigation.warnings(result.stdout)
        if #warnings>0 then warningCx:toast("warning","Tandem action completed",table.concat(warnings,"\n")) end
       elseif not quiet then warningCx:toast("error","Tandem action result unavailable",tostring(navigation)) end
       if done then done(warningCx) end
      end)
     end
    end)
   end)
  end)
  if not ok then
   if not quiet then launchCx:toast("error", "Tandem couldn't start that action", tostring(problem)) end
   if done then done(launchCx) end
  end
 end)
end

local function command(id: string, title: string, args: { string }, palette: boolean?)
 tern.command({ id = id, title = title,
  available = if palette == false then function() return false end else nil,
  run = function(cx) run(cx, args) end })
end

command("new-request", "Tandem: New request…", { "new-request" })
command("open-task", "Tandem: Open task…", { "open-task" })
command("board", "Tandem: Toggle board", { "board" })
command("prs", "Tandem: Show PRs", { "prs" })
command("usage", "Tandem: Usage", { "usage" })

for number = 1, 9 do
 local value = tostring(number)
 command("project-" .. value, "Tandem: Project " .. value, { "project", value }, false)
end
command("project-prev", "Tandem: Previous project", { "project", "prev" }, false)
command("project-next", "Tandem: Next project", { "project", "next" }, false)

tern.route.link(function(link, cx)
 local kind, id = string.match(link.url, "^tandem://([a-z]+)/([%w_-]+)$")
 if kind == "task" or kind == "brief" or (kind == "pr" and id and string.match(id, "^%d+$")) then
  run(cx, { "open", kind, id })
  return { handled = true }
 end
 return nil
end)

tern.route.open(function(req, cx)
 if string.match(req.path, "/native%-host/[%w%-]+%.tandem%-open%.json$") then
  local path=req.path
  tern.timer(1,function(loadCx)
   if not loadCx then return end
   local loaded,host=pcall(function() return require("./view-host") end)
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
local previous:Origin?=nil
local queue:{{origin:Origin,action:string}}={}
local busy=false
local head,tail=1,0
local function enqueue(origin:Origin,action:string)
 tail+=1; queue[tail]={origin=origin,action=action}
end
local function drain(cx:WindowCx)
 if busy or head>tail then return end
 busy=true
 local job=queue[head]
 queue[head]=nil; head+=1
 if head>tail then head,tail=1,0 end
 run(cx,{"project",job.action},job.origin,true,function(callbackCx)
  busy=false
  drain(callbackCx)
 end)
end
local function focused(cx:WindowCx):Origin?
 local pane=cx.session:focused()
 local info=if pane then cx.session:pane(pane) else nil
 if pane and info and info.cwd and string.sub(info.cwd,1,1)=="/" then return {pane=pane,cwd=info.cwd} end
 return nil
end
local function enter(cx:WindowCx)
 local next=focused(cx)
 if previous and next and previous.pane==next.pane then return end
 if previous then enqueue(previous,"away") end
 previous=next
 if next then enqueue(next,"entry") end
 drain(cx)
end
tern.on("focus",function(_ev:FocusEvent,cx:WindowCx) enter(cx) end)
local function pulse()
 tern.timer(60000,function(cx)
  if cx then
   local origin=focused(cx)
   if origin then enqueue(origin,"visible"); drain(cx) end
  end
  pulse()
 end)
end
tern.on("window_start",function(cx:WindowCx) enter(cx); pulse() end)
