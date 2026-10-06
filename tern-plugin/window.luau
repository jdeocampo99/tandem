--!strict
-- Window routing only. The CLI owns state, project lookup, opening views, and every action guard.
local nav=require("./navigation")
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
 local ok, problem = pcall(function()
  tern.process.run(argv, { cwd = "." }, function(result, callbackCx)
   if result.status ~= 0 and not quiet then
    (callbackCx or cx):toast("error", "Tandem couldn't run that action", result.stderr)
   elseif result.status == 0 then
    local warnings=nav.warnings(result.stdout)
    if #warnings>0 then (callbackCx or cx):toast("warning","Tandem action completed",table.concat(warnings,"\n")) end
   end
   if done then done(callbackCx or cx) end
  end)
 end)
 if not ok then
  if not quiet then cx:toast("error", "Tandem couldn't start that action", tostring(problem)) end
  if done then done(cx) end
 end
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

local viewHost = require("./view-host")
tern.route.open(function(req, cx)
 local hosted = viewHost.open(req, cx)
 if hosted then return hosted end
 if string.match(req.path, "%.tandem%-view%.json$") then
  run(cx, { "view-file", req.path })
  return { handled = true }
 end
 return nil
end)

-- Lifecycle context carries only the pane/cwd. The CLI proves project/session ownership,
-- redirects the recorded alert helper, and owns all visit/read-cursor policy.
local previous:Origin?=nil
local queue:{{origin:Origin,action:string}}={}
local busy=false
local function drain(cx:WindowCx)
 if busy or #queue==0 then return end
 busy=true
 local job=table.remove(queue,1)
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
 if previous then table.insert(queue,{origin=previous,action="away"}) end
 previous=next
 if next then table.insert(queue,{origin=next,action="entry"}) end
 drain(cx)
end
tern.on("focus",function(_ev:FocusEvent,cx:WindowCx) enter(cx) end)
local function pulse()
 tern.timer(60000,function(cx)
  if cx then
   local origin=focused(cx)
   if origin then table.insert(queue,{origin=origin,action="visible"}); drain(cx) end
  end
  pulse()
 end)
end
tern.on("window_start",function(cx:WindowCx) enter(cx); pulse() end)
