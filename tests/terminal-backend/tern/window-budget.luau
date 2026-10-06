-- Execute the real window entrypoint and navigation helper. Expire every WindowCx;
-- cold compilation costs 35 ms and process launch costs 40 ms in this guard VM.
local hooks,commands,timers,processes,imports,toasts={},{},{},{},{},{}
local active,cost,maximum,label=false,0,0,""
local selected,cwd,spawnFailure=10,"/project a",false
local moduleFailure=nil
local function charge(ms)
 assert(active,"effect outside a callback")
 cost+=ms
 assert(cost<50,label .. " exceeded 50 ms: " .. cost)
 maximum=math.max(maximum,cost)
end
local function cx()
 local live=true
 local function check() assert(live,"expired WindowCx"); charge(5) end
 return {session={focused=function() check(); return selected end,pane=function(_,id) check(); return {pane=id,cwd=cwd} end},toast=function(_,level,_title,message) check(); table.insert(toasts,{level=level,message=message}) end},function() live=false end
end
local function invoke(name,fn)
 local context,expire=cx()
 active,cost,label=true,0,name
 fn(context)
 active=false; expire()
end
local response={}
local tern={
 command=function(def) commands[def.id]=def end,
 on=function(name,fn) hooks[name]=fn end,
 route={open=function(fn) hooks.open=fn end,link=function(fn) hooks.link=fn end},
 timer=function(ms,fn) charge(1); table.insert(timers,{ms=ms,fn=fn}) end,
 getenv=function() charge(1); return "window" end,
 process={run=function(argv,_opts,fn)
  charge(40)
  if spawnFailure then error("spawn refused") end
  table.insert(processes,{argv=argv,fn=fn})
 end},
 json={decode=function(raw) charge(2); if raw=="malformed" then error("bad JSON") end; return response end},
}
local loadNavigation
local function loadModule(name)
 if moduleFailure==name then charge(35); error("module refused") end
 if not imports[name] then charge(35); imports[name]=true end
 if name=="./navigation" then return loadNavigation() end
 assert(name=="./view-host")
 return {open=function(req,_cx) charge(5); assert(req.path=="/home/native-host/id.tandem-open.json"); return {handled=true} end}
end
-- ENTRY_POINT
assert(next(imports)==nil and #timers==0)
local function tick()
 for i,timer in timers do
  if timer.ms<60000 then table.remove(timers,i); invoke("timer",timer.fn); return true end
 end
 return false
end
local function settle(status,stdout)
 local pending=table.remove(processes,1)
 assert(pending,"no pending process")
 invoke("process",function(context) pending.fn({status=status or 0,stdout=stdout or "ok",stderr="refused"},context) end)
 assert(cost==1,"process callback must only schedule one continuation")
 while tick() do end
 return pending.argv
end
for id,command in commands do
 if command.available then invoke("available",function() assert(command.available()==false) end) end
 invoke("command:"..id,command.run)
 assert(#processes==0,"command must defer its launch")
 while tick() do end
 assert(#processes==1)
 settle()
end
response={entered=true,warnings={"Project opened, but catch-up is unavailable: fixture"}}
invoke("warning-command",commands.board.run); while tick() do end; settle()
assert(toasts[#toasts].level=="warning")
moduleFailure="./navigation"
invoke("helper-failure",commands.board.run); while tick() do end; settle()
assert(string.find(toasts[#toasts].message,"module refused"))
moduleFailure=nil
response={}
invoke("failed-command",commands.usage.run); while tick() do end; settle(7)
assert(toasts[#toasts].message=="refused")
invoke("malformed-result",commands.prs.run); while tick() do end; settle(0,"malformed")
spawnFailure=true
invoke("spawn-failure",commands.prs.run); while tick() do end
assert(#processes==0 and string.find(toasts[#toasts].message,"spawn refused"))
spawnFailure=false
for _,missing in {"", "relative"} do
 cwd=missing
 invoke("missing-origin",commands.prs.run)
 assert(#processes==0 and #timers==0)
end
cwd="/project a"
-- Origin remains the gesture's pane/cwd even if focus changes before launch.
invoke("origin-capture",commands.board.run); selected,cwd=20,"/project b"
while tick() do end
local argv=settle()
assert(table.find(argv,"10") and table.find(argv,"/project a"))
for _,url in {"tandem://task/task-1","tandem://brief/brief-1","tandem://pr/282"} do
 invoke("route.link",function(context) assert(hooks.link({url=url},context).handled) end)
 while tick() do end; settle()
end
invoke("route.link:unrelated",function(context) assert(hooks.link({url="https://example.invalid"},context)==nil) end)
invoke("route.open:unrelated",function(context) assert(hooks.open({path="/plain.txt"},context)==nil) end)
moduleFailure="./view-host"
invoke("route.open:load-failure",function(context) assert(hooks.open({path="/home/native-host/id.tandem-open.json"},context).handled) end)
while tick() do end
assert(string.find(toasts[#toasts].message,"module refused"))
moduleFailure=nil
invoke("route.open:ticket",function(context) assert(hooks.open({path="/home/native-host/id.tandem-open.json"},context).handled) end)
assert(imports["./view-host"]==nil,"route must defer cold hosting load")
while tick() do end
invoke("window_start",hooks.window_start); while tick() do end
-- Burst focus queues away/entry pairs. Completion cannot launch the next process inline,
-- including failed results and known launch failures. Queue order stays intact.
for id=21,45 do
 selected=id
 invoke("focus",function(context) hooks.focus({},context) end)
end
local actions={}
while #processes>0 do
 local args=settle(if #actions%3==0 then 7 else 0)
 table.insert(actions,args[5])
end
assert(#actions==51 and actions[1]=="entry")
for i=2,#actions,2 do assert(actions[i]=="away" and actions[i+1]=="entry") end
invoke("duplicate-focus",function(context) hooks.focus({},context) end)
assert(#processes==0)
local pulse=table.remove(timers,1)
assert(pulse.ms==60000)
invoke("heartbeat",pulse.fn); while tick() do end
assert(settle()[5]=="visible")
-- Queue launch failures settle one job per fresh timer and do not wedge later entries.
spawnFailure=true; selected=46
invoke("focus:spawn-failure",function(context) hooks.focus({},context) end)
while tick() do end
assert(#processes==0)
spawnFailure=false; selected=47
invoke("focus:after-failure",function(context) hooks.focus({},context) end)
while tick() do end
assert(settle()[5]=="away" and settle()[5]=="entry")
-- A vanished window gets no context and never launches or retains a stale one.
invoke("vanished-command",commands.board.run)
local abandoned=table.remove(timers,#timers)
invoke("vanished-timer",function() abandoned.fn(nil) end)
assert(#processes==0)
print("Every window hook path stays below 50 ms; max charged callback ms:",maximum)
