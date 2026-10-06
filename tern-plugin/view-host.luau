--!strict
-- Only immutable backend-authored opening tickets can reach the native layout API.
local M = {}
local kinds = { panel=true, task=true, brief=true, pr=true, prs=true, board=true, usage=true, catchup=true, welcome=true, ["task-picker"]=true }
-- Every window callback has a 50 ms budget. Yield between native calls, and use only the
-- fresh WindowCx supplied to that callback. Never keep a context after its handler returns.
local function call<T>(operation: (WindowCx) -> T): T
 return coroutine.yield(operation)
end
local function host(path: string)
 local ok, ticket = pcall(function() return tern.json.decode(tern.fs.read(path, 16384)) end)
 if not ok or type(ticket) ~= "table" or ticket.version ~= 1 or not kinds[ticket.kind]
  or type(ticket.args) ~= "table" or #ticket.args ~= 5 or type(ticket.receipt) ~= "string"
  or not string.match(ticket.receipt, "/native%-host/[%w%-]+%.receipt%.json$") then
  error("Invalid opening ticket")
 end
 local coordinator = tonumber(ticket.coordinator)
 local origin = tonumber(ticket.origin)
 local owner = if coordinator then call(function(cx) return cx.session:pane(coordinator) end) else nil
 local source = if origin then call(function(cx) return cx.session:pane(origin) end) else nil
 if not owner or not source or not owner.tab or not source.tab then
  error("Exact originating panes disappeared")
 end
 local session = tonumber(ticket.session)
 local same, sameOrigin = false, false
 for _, tab in call(function(cx) return cx.session:tabs() end) do
  if tab.id == owner.tab and tab.session == session then same=true end
  if tab.id == source.tab and tab.session == session then sameOrigin=true end
 end
 if not same or not sameOrigin then error("Exact originating session changed") end
 local originClosed=false
 local ownerFloating=owner.floating==true
 -- Recheck both exact panes in the live session immediately before each layout effect.
 local function effect<T>(operation: (WindowCx, PaneInfo?) -> T): T
  return call(function(cx)
   local liveOwner = cx.session:pane(coordinator)
   local liveSource = if origin==coordinator then liveOwner else cx.session:pane(origin)
   if not liveOwner or liveOwner.tab~=owner.tab or liveOwner.block~=owner.block
    or (liveOwner.floating==true)~=ownerFloating then error("Exact coordinator changed") end
   if originClosed then
    if liveSource then error("Closed originating pane reappeared") end
   elseif not liveSource or liveSource.tab~=source.tab or liveSource.block~=source.block
    or (origin~=coordinator and (liveSource.floating==true)~=(source.floating==true)) then error("Exact originating pane changed") end
   return operation(cx,liveSource)
  end)
 end
 local pane: number?
 local previous=if ticket.replaced then tonumber(ticket.replaced) else nil
 local function previousTask(cx: WindowCx, liveSource: PaneInfo?)
  local current=if previous==origin then liveSource elseif previous then cx.session:pane(previous) else nil
  if not current or current.block~="tandem.task" or current.tab~=owner.tab or current.floating then
   error("Task return target changed")
  end
 end
 if ticket.placement=="inbox" then
  effect(function(cx) cx:command("inbox") end)
  pane=origin
 elseif ticket.placement=="return" then
  if source.block=="tandem.task-picker" then
   local old=if previous then call(function(cx) return cx.session:pane(previous) end) else nil
   local layout=call(function(cx) return cx.session:layout(owner.tab) end)
   if owner.floating and (not old or old.block~="tandem.task" or old.tab~=owner.tab or old.floating
    or not layout or #layout.floats~=1 or layout.floats[1].pane~=coordinator) then error("Task picker layout changed") end
   effect(function(cx,liveSource)
    if owner.floating then previousTask(cx,liveSource) end
    cx.layout:close(origin); originClosed=true
   end)
  elseif owner.floating then
   local old=if previous then call(function(cx) return cx.session:pane(previous) end) else nil
   local layout=call(function(cx) return cx.session:layout(owner.tab) end)
   if not old or old.block~="tandem.task" or old.tab~=owner.tab or old.floating
    or not layout or #layout.floats~=1 or layout.floats[1].pane~=coordinator then error("Task return layout changed") end
   if not effect(function(cx,liveSource)
    previousTask(cx,liveSource)
    local current=cx.session:layout(owner.tab)
    if not current or #current.floats~=1 or current.floats[1].pane~=coordinator then error("Task return layout changed") end
    local docked=cx.layout:dock(coordinator,previous,"right",{focus=false})
    if docked then ownerFloating=false end
    return docked
   end) then error("Coordinator could not dock") end
   effect(function(cx)
    local current=cx.session:pane(previous)
    if not current or current.block~="tandem.task" or current.tab~=owner.tab or current.floating then error("Task identity changed") end
    cx.layout:close(previous)
    if previous==origin then originClosed=true end
   end)
  end
  if ticket.closeOrigin then
   if tonumber(ticket.closeOrigin)~=origin or
    (source.block~="tandem.board" and source.block~="tandem.usage" and source.block~="tandem.catchup") then error("Return origin identity changed") end
   effect(function(cx) cx.layout:close(origin); originClosed=true end)
  end
  -- The origin may have just been closed by this ticket; focus only the exact coordinator.
  effect(function(cx)
   local target=if source.block=="tandem.task-picker" and owner.floating then previous else coordinator
   if target~=coordinator then
    local old=cx.session:pane(target)
    if not old or old.block~="tandem.task" or old.tab~=owner.tab or old.floating then error("Task return target changed") end
   end
   cx.layout:focus(target)
  end)
  pane=coordinator
 else
  if ticket.placement=="task" then
   local layout=call(function(cx) return cx.session:layout(owner.tab) end)
   if not layout then error("Task layout disappeared") end
   if owner.floating then
    local old=if previous then call(function(cx) return cx.session:pane(previous) end) else nil
    if #layout.floats~=1 or layout.floats[1].pane~=coordinator or not old
     or old.tab~=owner.tab or old.block~="tandem.task" or old.floating then error("Task replacement layout changed") end
   elseif #layout.floats>0 or previous then error("Unrelated floating layout") end
  end
  pane=effect(function(cx)
   -- Creation uses the currently focused host. Keep focus and creation in one callback so
   -- navigation between timer stages cannot redirect a block into an unrelated project.
   local target=if ticket.placement=="task" and owner.floating then previous else coordinator
   if target~=coordinator and target~=origin then
    local current=cx.session:pane(target)
    if not current or current.tab~=owner.tab or current.block~="tandem.task" or current.floating then error("Task replacement target changed") end
   end
   cx.layout:focus(target)
   return cx:new_block("tandem." .. ticket.kind,ticket.args,if ticket.placement=="window" then "tab" else "beside",{focus=ticket.placement~="panel",keep_open=false})
  end)
  if not pane then error("Native block could not open") end
  if ticket.placement=="panel" then
   if not effect(function(cx) return cx.layout:move(pane,coordinator,"left",{focus=false}) end) then error("Panel could not move") end
   -- PaneInfo has no geometry, and daemon columns can remain 80 for hidden/native
   -- blocks. Calibrate against this window's usable layout after placement instead.
   local function panelRatio(cx: WindowCx): number
    local layout=cx.session:layout(owner.tab)
    local function find(tree: TabTree): number?
     if tree.split=="right" and tree[1] and tree[1].pane==pane then return tree.ratio end
     for _,child in tree do
      if type(child)=="table" then
       local ratio=find(child)
       if ratio then return ratio end
      end
     end
     return nil
    end
    local ratio=if layout then find(layout.root) else nil
    if not ratio or ratio<=0 or ratio>=1 then error("Panel divider unavailable") end
    return ratio
   end
   local before=effect(function(cx) return panelRatio(cx) end)
   if not effect(function(cx) return cx.layout:resize(pane,"right",1) end) then error("Panel divider could not move") end
   local after=effect(function(cx) return panelRatio(cx) end)
   local step=after-before
   if math.abs(step)<0.000001 then error("Panel geometry did not update") end
   local target=45*math.abs(step)
   local cells=math.round((target-after)/step)
   if cells~=0 and not effect(function(cx)
    if math.abs(panelRatio(cx)-after)>0.000001 then error("Panel layout changed during sizing") end
    return cx.layout:resize(pane,"right",cells)
   end) then error("Panel could not resize") end
   local actual=effect(function(cx) return panelRatio(cx) end)
   if math.abs(actual-target)>math.abs(step)*1.1 then error("Panel width could not be confirmed") end
   effect(function(cx) cx.layout:focus(coordinator) end)
  elseif ticket.placement=="task" then
   if not effect(function(cx)
    local current=cx.session:layout(owner.tab)
    if not current or #current.floats~=(if ownerFloating then 1 else 0)
     or (ownerFloating and current.floats[1].pane~=coordinator) then error("Task floating layout changed") end
    local floated=cx.layout:float(coordinator,pane,"br",{focus=false})
    if floated then ownerFloating=true end
    return floated
   end) then error("Coordinator could not float") end
   if previous then effect(function(cx)
    local current=cx.session:pane(previous)
    if not current or current.block~="tandem.task" or current.tab~=owner.tab or current.floating then error("Task identity changed") end
    cx.layout:close(previous)
    if previous==origin then originClosed=true end
   end) end
   effect(function(cx) cx.layout:focus(pane); cx:command("pip_stash_all") end)
   effect(function(cx) cx.layout:focus(pane) end)
  end
 end
 local tab=if pane then call(function(cx) return cx.session:tab_of(pane) end) else nil
 if pane and tab then tern.fs.write(ticket.receipt,tern.json.encode({paneId=string.format("%.0f",pane),tabId=string.format("%.0f",tab),sessionId=ticket.session})) end
end

function M.open(req: OpenRequest, _cx: WindowCx): RouteDecision?
 if not string.match(req.path, "/native%-host/[%w%-]+%.tandem%-open%.json$") then return nil end
 local thread=coroutine.create(function() host(req.path) end)
 local function advance(value)
  local ok, operation=coroutine.resume(thread,value)
  if not ok then error(operation) end
  if coroutine.status(thread)=="dead" then return end
  tern.timer(1,function(cx)
   if not cx then return end
   local ran, problem=pcall(function() advance(operation(cx)) end)
   if not ran then cx:toast("error","Tandem view did not open",tostring(problem)) end
  end)
 end
 -- Consume the private ticket before any file read or native layout work. Each callback
 -- is invoked once; failures leave the backend's immutable ticket and intent quarantined.
 tern.timer(1,function(cx)
  if not cx then return end
  local ok, problem=pcall(function() advance(nil) end)
  if not ok then cx:toast("error","Tandem view did not open",tostring(problem)) end
 end)
 return {handled=true}
end
return M
