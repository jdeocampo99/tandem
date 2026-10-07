-- Reads cost 5 ms and layout effects cost 10 ms. Contexts expire when their callback returns.
-- A synchronous panel route exceeds Tern's 50 ms budget; staged calls must stay below it.
-- TICKETS, NOW_S, ROUTE and `encode` come from layout.test.ts; every ticket is TS-built.
local timers, writes, effects, toasts, panes = {}, {}, {}, {}, {}
local faultAt: number? = nil
local active, calls, maximum, focused = false, 0, 0, 10
local ticket
local failMove,raiseMove=false,false
-- Tern retires a raw-closed pane after the callback returns; closeAfter counts later callbacks.
local closeAfter,closing=0,{}
local width,ratio,failResize,ignoreResize=198,0.5,false,false
 span=1
local span=1
local fault=false
local function charge(alive,cost)
 assert(active and alive(), "expired window context")
 if fault then fault=false; error("injected fault") end
 calls += cost or 10
 assert(calls < 50, "callback exceeded its 50 ms budget")
 maximum=math.max(maximum,calls)
end
tern.timer=function(_delay,callback) table.insert(timers,callback) end
tern.fs={read=function() assert(active); return "ticket" end,write=function(path,value) writes[path]=value end}
tern.json={decode=function() return ticket end,encode=function(value) return value end}
local function context()
 local live=true
 local function alive() return live end
 local cx={session={},layout={}}
 function cx.session:pane(id) charge(alive,5); return if panes[id] then table.clone(panes[id]) else nil end
 function cx.session:tabs() charge(alive,5); return {{id=11,session=1},{id=21,session=2},{id=22,session=2}} end
 function cx.session:layout(_tab)
  charge(alive,5)
  local root={split="right",ratio=ratio,{pane=30},{pane=20}}
  if span~=1 then root={split="right",ratio=span,root,{pane=60}} end
  return {root=root,floats=if panes[20].floating then {{pane=20}} else {}}
 end
 function cx.session:tab_of(id) charge(alive,5); return if panes[id] then panes[id].tab else nil end
 function cx:new_block(kind,args,how,options)
  charge(alive)
  assert(focused==(if ticket.placement=="task" and panes[20].floating then tonumber(ticket.replaced) else tonumber(ticket.coordinator)),"block creation followed another project's focus")
  assert(options.keep_open==false)
  table.insert(effects,{name="new",kind=kind,args=args,how=how})
  panes[30]={tab=if how=="tab" then 22 else 21,block=kind,floating=false,args=args}
  return 30
 end
 function cx.layout:focus(id) charge(alive); assert(panes[id]); focused=id; table.insert(effects,{name="focus",id=id}) end
 function cx.layout:move(id,_owner,_direction,_options)
  charge(alive); assert(panes[id]); table.insert(effects,{name="move"})
  if raiseMove then error("Tern rejected the move") end
  return not failMove
 end
 function cx.layout:resize(id,direction,amount)
  charge(alive); assert(panes[id] and direction=="right"); table.insert(effects,{name="resize",cells=amount})
  if failResize then return false end
  if not ignoreResize then ratio=math.clamp(ratio-amount/width,0.1,0.9) end
  return true
 end
 function cx.layout:close(id)
  charge(alive); assert(panes[id]); table.insert(effects,{name="close",id=id})
  if closeAfter==0 then panes[id]=nil else closing[id]=closeAfter end
 end
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
local function clone(value)
 if type(value)~="table" then return value end
 local copy={}
 for key,item in value do copy[key]=clone(item) end
 return copy
end
local function reset(kind,placement)
 timers,writes,effects,toasts={}, {}, {}, {}
 failMove,raiseMove=false,false
 closeAfter,closing=0,{}
 width,ratio,failResize,ignoreResize=198,0.5,false,false
 span=1
 panes={[10]={tab=11,block="shell",floating=false},[20]={tab=21,block="shell",floating=false}}
 ticket=clone(assert(TICKETS[kind .. "/" .. placement],"no TS ticket for " .. kind .. "/" .. placement))
end
local function drain(before)
 local index=0
 while #timers>0 do
  index+=1; assert(index<50,"timer loop")
  local callback=table.remove(timers,1)
  local windowGone=before and before(index)
  for id,left in closing do
   if left<=1 then panes[id]=nil; closing[id]=nil else closing[id]=left-1 end
  end
  local cx,expire=context()
  active,calls,focused=true,0,10
  fault=faultAt==index
  callback(if windowGone then nil else cx)
  fault=false
  active=false; expire()
 end
end
local function open()
 local cx,expire=context()
 active,calls=true,0
 local result=host.open({path=ROUTE},cx)
 assert(result.handled and calls==0 and #effects==0,"route must consume ticket before native work")
 active=false; expire()
end
local function failed(applied: number?)
 local receipt=writes[ticket.receipt]
 return receipt~=nil and receipt.status=="failed" and type(receipt.reason)=="string"
  and (if applied then receipt.appliedEffects==applied else receipt.appliedEffects>0)
end
local function done(pane: string)
 local receipt=writes[ticket.receipt]
 return receipt~=nil and receipt.status=="done" and receipt.paneId==pane
end

reset("panel","panel"); open(); drain()
assert(#toasts==0 and done("30"))
assert(#effects==6 and effects[2].kind=="tandem.panel")
assert(math.abs(ratio*width-45)<=1,"panel must measure 45 live cells")
assert(panes[10] and panes[20],"opening B must preserve both coordinators")
-- Native/hidden blocks report stale daemon columns. Calibrate with the current
-- window size after placement, including another project selected between stages.
for _,liveWidth in {120,198,320} do
 reset("panel","panel"); width=liveWidth; open(); drain()
 assert(#toasts==0 and writes[ticket.receipt] and math.abs(ratio*width-45)<=1)
end
-- Existing brief/PR splits put the panel divider inside a horizontal ancestor.
-- Resize uses full-window cells on Tern 0.5.1, so local ratio alone halves the width.
for _,ancestorShare in {0.5,0.75,0.3} do
 reset("panel","panel"); span=ancestorShare; open(); drain()
 assert(#toasts==0 and writes[ticket.receipt] and math.abs(ratio*span*width-45)<=1,
  "nested panel must occupy 45 actual full-window cells")
end
for _,failure in {"no-divider","no-update","clamped"} do
 reset("panel","panel")
 if failure=="no-divider" then failResize=true elseif failure=="no-update" then ignoreResize=true else width=600 end
 open(); drain()
 assert(#toasts==1 and failed(),"unconfirmed panel width must report its applied effects")
 assert(panes[30] and panes[20] and #timers==0,"failed placement preserves ownership without retry")
end
reset("panel","panel"); open()
drain(function(index) if index==9 then span=0.5 end end)
assert(#toasts==1 and failed() and panes[30],"ancestor changes between calibration stages must stay fenced")
reset("catchup","window"); open(); drain()
assert(#toasts==0 and writes[ticket.receipt].tabId=="22")
assert(effects[2].kind=="tandem.catchup" and effects[2].how=="tab")

-- Losing exact identity before any effect reports that nothing changed and never retries.
reset("panel","panel"); open()
drain(function(index) if index==5 then panes[20].block="foreign" end end)
assert(#toasts==1 and failed(0) and #effects==0)
assert(writes[ticket.receipt].stage=="panel")
assert(#timers==0)

-- Losing it after the block opened reports exactly that one effect.
reset("panel","panel"); open()
drain(function(index) if index==6 then panes[20].block="foreign" end end)
assert(#toasts==1 and failed(1) and panes[30] and #timers==0)

reset("panel","panel"); failMove=true; open(); drain()
local creations=0
for _,effect in effects do if effect.name=="new" then creations+=1 end end
assert(creations==1 and panes[30] and #toasts==1 and failed(2))
assert(#effects==3 and #timers==0,"uncertain partial layout must stay retained without retry")

-- An error Tern raises inside a staged timer callback still writes the receipt once.
reset("panel","panel"); raiseMove=true; open(); drain()
assert(#toasts==1 and failed(2) and string.find(writes[ticket.receipt].reason,"Tern rejected the move"))
assert(#timers==0,"a failed callback never schedules another stage")

-- A window that closes between stages leaves no context to toast with, but still a receipt.
reset("panel","panel"); open()
drain(function(index) return index==5 end)
assert(#toasts==0 and failed(0) and #effects==0 and #timers==0)

-- A Tern that never retires the replaced task fails after its effects instead of claiming done.
reset("task","task")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
ticket.replaced="40"
closeAfter=math.huge
open(); drain()
assert(#toasts==1 and failed() and panes[40] and panes[30],"an unconfirmed close must not write done")

reset("panel","panel"); ticket.session="1"; open(); drain()
assert(#toasts==1 and failed(0) and #effects==0,"foreign session must stay fenced")
reset("panel","panel"); table.insert(ticket.args,"extra"); open(); drain()
assert(#toasts==1 and failed(0) and #effects==0,"invalid ticket must stay consumed")
assert(writes[ticket.receipt].stage=="ticket")

-- An expired ticket changes nothing; one that expires between stages stops before its next effect.
reset("panel","panel"); ticket.expiresAt=NOW_S*1000; open(); drain()
assert(#toasts==1 and failed(0) and #effects==0 and writes[ticket.receipt].stage=="ticket")
reset("panel","panel"); open()
drain(function(index) if index==6 then ticket.expiresAt=NOW_S*1000 end end)
assert(#toasts==1 and failed(1) and panes[30] and #timers==0,"expiry mid-open reports what it applied")

-- A root Back closes the originating native view, then focuses the still-proven owner.
reset("panel","return-board")
panes[30]={tab=22,block="tandem.catchup",floating=false}
open(); drain()
assert(#toasts==0 and panes[30]==nil and done("20"))
assert(effects[1].name=="close" and effects[2].id==20)

-- Tern retires the replaced task a few callbacks after the close; the receipt waits for it.
reset("task","task-replace")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
closeAfter=3
open(); drain()
assert(#toasts==0 and panes[40]==nil and panes[30] and done("30"))
assert(effects[#effects].name=="focus" and effects[#effects].id==30,"replacement must finish after closing its origin")

reset("panel","return")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
ticket.origin="40"; ticket.replaced="40"
open(); drain()
assert(#toasts==0 and panes[40]==nil and not panes[20].floating and done("20"))

reset("panel","return-picker")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
panes[50]={tab=21,block="tandem.task-picker",floating=false}
open(); drain()
assert(#toasts==0 and panes[50]==nil and panes[40] and panes[20].floating and done("20"))

-- Back can originate outside the previous task. Recheck that task immediately before
-- closing the picker or docking its coordinator, after the earlier pane/layout reads.
for _,source in {"tandem.task-picker","tandem.panel"} do
 for _,change in {"missing","kind","tab","floating"} do
  reset("panel","return")
  panes[20].floating=true
  panes[40]={tab=21,block="tandem.task",floating=false}
  panes[50]={tab=21,block=source,floating=false}
  ticket.origin="50"
  if source=="tandem.task-picker" then ticket.returnTo="40" else ticket.replaced="40" end
  open()
  drain(function(index)
   if index==6 then
    if change=="missing" then panes[40]=nil
    elseif change=="kind" then panes[40].block="foreign"
    elseif change=="tab" then panes[40].tab=11
    else panes[40].floating=true end
   end
  end)
  assert(#toasts==1 and failed(0) and #effects==0,
   "Back must refuse a changed previous task before any effect: " .. source .. "/" .. change)
  assert(panes[50] and panes[20].floating and #timers==0,"Back must preserve panes without retry")
 end
end

reset("panel","return")
panes[20].floating=true
panes[40]={tab=21,block="tandem.task",floating=false}
panes[50]={tab=21,block="tandem.panel",floating=false}
ticket.origin="50"; ticket.replaced="40"
open(); drain()
assert(#toasts==0 and panes[50] and panes[40]==nil and not panes[20].floating)
assert(done("20"),"Back from panel must still dock and retire the task")

reset("panel","panel"); open()
drain(function(index) if index==5 then panes[20].floating=true end end)
assert(#toasts==1 and failed(0) and #effects==0,"changed floating ownership must stay fenced")

reset("panel","panel")
local cx,expire=context()
assert(host.open({path="/b/ordinary.json"},cx)==nil and #timers==0)
expire()

-- T4: every TS-built ticket, with a fault injected at each stage in turn. Each run prints its
-- receipt and the panes it left, so the test can check `decide()` against them.
local function setup(name)
 if name=="task/task-replace" or name=="panel/return-task" or name=="panel/return-picker" then
  panes[20].floating=true
  panes[40]={tab=21,block="tandem.task",floating=false}
  if name=="panel/return-picker" then panes[50]={tab=21,block="tandem.task-picker",floating=false} end
 elseif name=="panel/return-board" then
  panes[30]={tab=22,block="tandem.catchup",floating=false}
 end
end
-- Everything a layout effect can change: each pane's tab, kind and floating state, and the split.
local function snapshot(): string
 local ids={}
 for id in panes do table.insert(ids,id) end
 table.sort(ids)
 local parts={}
 for _,id in ids do
  local pane=panes[id]
  table.insert(parts,string.format("%d:%d:%s:%s",id,pane.tab,pane.block,tostring(pane.floating==true)))
 end
 return table.concat(parts,",") .. string.format("|%.6f|%.6f",ratio,span)
end
local function emit(name,stage,before)
 local listed={}
 for id,pane in panes do table.insert(listed,{id=id,tab=pane.tab,block=pane.block,args=pane.args}) end
 print("T4\t" .. name .. "\t" .. stage .. "\t" .. encode(writes[ticket.receipt]) .. "\t" .. encode(listed)
  .. "\t" .. tostring(before~=snapshot()))
end
for _,name in SWEEP do
 local kind,placement=string.match(name,"^([^/]+)/(.+)$")
 reset(kind,placement); setup(name)
 local before=snapshot()
 open()
 local stages=0
 drain(function(index) stages=index end)
 emit(name,0,before)
 for stage=1,stages do
  reset(kind,placement); setup(name); before=snapshot(); faultAt=stage; open(); drain(); faultAt=nil
  emit(name,stage,before)
 end
end
print("Staged layout, second-project views, fresh contexts, expiry and quarantine checks passed")
