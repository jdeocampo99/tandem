-- Each native API call costs 10 ms. Contexts expire when their callback returns.
-- A synchronous panel route exceeds Tern's 50 ms budget; staged calls must stay below it.
local timers, writes, effects, toasts, panes = {}, {}, {}, {}, {}
local active, calls, maximum, focused = false, 0, 0, 10
local ticket
local failMove=false
local function charge(alive)
 assert(active and alive(), "expired window context")
 calls += 1
 assert(calls < 5, "callback exceeded its 50 ms budget")
 maximum=math.max(maximum,calls)
end
tern.timer=function(_delay,callback) table.insert(timers,callback) end
tern.fs={read=function() assert(active); return "ticket" end,write=function(path,value) writes[path]=value end}
tern.json={decode=function() return ticket end,encode=function(value) return value end}
local function context()
 local live=true
 local function alive() return live end
 local cx={session={},layout={}}
 function cx.session:pane(id) charge(alive); return if panes[id] then table.clone(panes[id]) else nil end
 function cx.session:tabs() charge(alive); return {{id=11,session=1},{id=21,session=2},{id=22,session=2}} end
 function cx.session:layout(_tab) charge(alive); return {floats=if panes[20].floating then {{pane=20}} else {}} end
 function cx.session:tab_of(id) charge(alive); return if panes[id] then panes[id].tab else nil end
 function cx:new_block(kind,args,how,options)
  charge(alive)
  assert(focused==(if ticket.placement=="task" and panes[20].floating then tonumber(ticket.replaced) else tonumber(ticket.coordinator)),"block creation followed another project's focus")
  assert(options.keep_open==false)
  table.insert(effects,{name="new",kind=kind,args=args,how=how})
  panes[30]={tab=if how=="tab" then 22 else 21,block=kind,floating=false}
  return 30
 end
 function cx.layout:focus(id) charge(alive); assert(panes[id]); focused=id; table.insert(effects,{name="focus",id=id}) end
 function cx.layout:move(id,_owner,_direction,_options) charge(alive); assert(panes[id]); table.insert(effects,{name="move"}); return not failMove end
 function cx.layout:resize(id,_direction,_amount) charge(alive); assert(panes[id]); table.insert(effects,{name="resize"}) end
 function cx.layout:close(id) charge(alive); assert(panes[id]); panes[id]=nil; table.insert(effects,{name="close",id=id}) end
 function cx.layout:float(id,_over,_corner,_options) charge(alive); panes[id].floating=true; table.insert(effects,{name="float"}); return true end
 function cx.layout:dock(id,_over,_direction,_options) charge(alive); panes[id].floating=false; table.insert(effects,{name="dock"}); return true end
 function cx:command(name)
  charge(alive)
  if name=="pip_stash_all" then assert(focused==30,"stash followed another project's focus") end
  table.insert(effects,{name=name})
 end
 function cx:toast(_kind,_title,message) charge(alive); table.insert(toasts,message) end
 return cx,function() live=false end
end
local function reset(kind,placement)
 timers,writes,effects,toasts={}, {}, {}, {}
 failMove=false
 panes={[10]={tab=11,block="shell",floating=false},[20]={tab=21,block="shell",floating=false}}
 ticket={version=1,kind=kind,placement=placement,args={"/b/index", "20", "/b", "", "/b/index"},coordinator="20",origin="20",session="2",receipt="/b/native-host/open.receipt.json"}
end
local function drain(before)
 local index=0
 while #timers>0 do
  index+=1; assert(index<50,"timer loop")
  local callback=table.remove(timers,1)
  if before then before(index) end
  local cx,expire=context()
  active,calls,focused=true,0,10
  callback(cx)
  active=false; expire()
 end
end
local function open()
 local cx,expire=context()
 active,calls=true,0
 local result=host.open({path="/b/native-host/open.tandem-open.json"},cx)
 assert(result.handled and calls==0 and #effects==0,"route must consume ticket before native work")
 active=false; expire()
end

reset("panel","panel"); open(); drain()
assert(#toasts==0 and writes[ticket.receipt].paneId=="30")
assert(#effects==5 and effects[2].kind=="tandem.panel")
assert(panes[10] and panes[20],"opening B must preserve both coordinators")
reset("catchup","window"); open(); drain()
assert(#toasts==0 and writes[ticket.receipt].tabId=="22")
assert(effects[2].kind=="tandem.catchup" and effects[2].how=="tab")

-- Losing exact identity between stages leaves no receipt and never retries the effect.
reset("panel","panel"); open()
drain(function(index) if index==5 then panes[20].block="foreign" end end)
assert(#toasts==1 and writes[ticket.receipt]==nil and #effects==0)
assert(#timers==0)

reset("panel","panel"); failMove=true; open(); drain()
local creations=0
for _,effect in effects do if effect.name=="new" then creations+=1 end end
assert(creations==1 and panes[30] and #toasts==1 and writes[ticket.receipt]==nil)
assert(#effects==3 and #timers==0,"uncertain partial layout must stay retained without retry or receipt")

reset("panel","panel"); ticket.session="1"; open(); drain()
assert(#toasts==1 and writes[ticket.receipt]==nil and #effects==0,"foreign session must stay fenced")
reset("foreign","panel"); open(); drain()
assert(#toasts==1 and writes[ticket.receipt]==nil and #effects==0,"invalid ticket must stay consumed")

-- A root Back closes the originating native view, then focuses the still-proven owner.
reset("panel","return")
panes[30]={tab=22,block="tandem.catchup",floating=false}
ticket.origin="30"; ticket.closeOrigin="30"
open(); drain()
assert(#toasts==0 and panes[30]==nil and writes[ticket.receipt].paneId=="20")
assert(effects[1].name=="close" and effects[2].id==20)

reset("task","task")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
ticket.origin="40"; ticket.replaced="40"
open(); drain()
assert(#toasts==0 and panes[40]==nil and panes[30] and writes[ticket.receipt].paneId=="30")
assert(effects[#effects].name=="focus" and effects[#effects].id==30,"replacement must finish after closing its origin")

reset("panel","return")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
ticket.origin="40"; ticket.replaced="40"
open(); drain()
assert(#toasts==0 and panes[40]==nil and not panes[20].floating and writes[ticket.receipt].paneId=="20")

reset("panel","return")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
panes[50]={tab=21,block="tandem.task-picker",floating=false}
ticket.origin="50"; ticket.replaced="40"
open(); drain()
assert(#toasts==0 and panes[50]==nil and panes[40] and panes[20].floating and writes[ticket.receipt].paneId=="20")

reset("panel","panel"); open()
drain(function(index) if index==5 then panes[20].floating=true end end)
assert(#toasts==1 and writes[ticket.receipt]==nil and #effects==0,"changed floating ownership must stay fenced")

reset("panel","panel")
local cx,expire=context()
assert(host.open({path="/b/ordinary.json"},cx)==nil and #timers==0)
expire()
print("Staged routes, second-project views, fresh contexts and quarantine checks passed; max native calls per callback:", maximum)
