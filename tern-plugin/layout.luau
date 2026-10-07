--!strict
-- Interprets one backend-authored ticket (src/native/contract.ts `Ticket`). Every stage checks
-- the ticket's expiry, then rechecks its exact panes, then applies one effect. It never retries.
local M = {}
-- Every window callback has a 50 ms budget. Yield between native calls, and use only the
-- fresh WindowCx supplied to that callback. Never keep a context after its handler returns.
local function call<T>(operation: (WindowCx) -> T, delay: number?): T
 return coroutine.yield({operation=operation, delay=delay or 1})
end
-- Raw close has no acknowledgement and Tern retires the pane after the callback returns, so
-- only its observed absence proves the close. Poll for at most one second.
local CLOSE_POLL_MS, CLOSE_POLLS = 50, 20
type Run = {stage: string, applied: number}
local function host(path: string, receipt: string, run: Run): {[string]: string}
 local ok, ticket = pcall(function() return tern.json.decode(tern.fs.read(path, 16384)) end)
 if not ok or type(ticket) ~= "table" or ticket.version ~= 1 or type(ticket.kind) ~= "string"
  or type(ticket.args) ~= "table" or #ticket.args ~= 3 or ticket.receipt ~= receipt
  or type(ticket.expiresAt) ~= "number" then
  error("Invalid opening ticket")
 end
 -- A ticket the backend no longer waits for must not change the layout. os.time() has
 -- 1 s resolution, so a stage may start up to a second after `expiresAt`. That is safe: the
 -- backend quarantines a ticket at expiry rather than settling it, and decides a late receipt
 -- again.
 local function current()
  if os.time() * 1000 >= ticket.expiresAt then error("Opening ticket expired") end
 end
 current()
 run.stage="identity"
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
   current()
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
 -- Count every effect that can create, move or retire something before it runs, so a failure
 -- reports what it may have left behind. Focus alone leaves nothing to recover.
 local function apply()
  run.applied+=1
 end
 local function retire(id: number, recheck: ((WindowCx, PaneInfo?) -> ())?)
  effect(function(cx,liveSource)
   if recheck then recheck(cx,liveSource) end
   apply()
   cx.layout:close(id)
  end)
  for _=1,CLOSE_POLLS do
   if not call(function(cx) return cx.session:pane(id) end,CLOSE_POLL_MS) then
    if id==origin then originClosed=true end
    return
   end
  end
  error("Closed pane is still present")
 end
 local pane: number?
 local previous=if ticket.replaced then tonumber(ticket.replaced) else nil
 local function previousTask(cx: WindowCx, liveSource: PaneInfo?)
  local current=if previous==origin then liveSource elseif previous then cx.session:pane(previous) else nil
  if not current or current.block~="tandem.task" or current.tab~=owner.tab or current.floating then
   error("Task return target changed")
  end
 end
 local function sameTask(cx: WindowCx)
  local current=cx.session:pane(previous)
  if not current or current.block~="tandem.task" or current.tab~=owner.tab or current.floating then error("Task identity changed") end
 end
 run.stage=ticket.placement
 if ticket.placement=="inbox" then
  effect(function(cx) apply(); cx:command("inbox") end)
  pane=origin
 elseif ticket.placement=="return" then
  if source.block=="tandem.task-picker" then
   local old=if previous then call(function(cx) return cx.session:pane(previous) end) else nil
   local layout=call(function(cx) return cx.session:layout(owner.tab) end)
   if owner.floating and (not old or old.block~="tandem.task" or old.tab~=owner.tab or old.floating
    or not layout or #layout.floats~=1 or layout.floats[1].pane~=coordinator) then error("Task picker layout changed") end
   retire(origin,function(cx,liveSource)
    if owner.floating then previousTask(cx,liveSource) end
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
    apply()
    local docked=cx.layout:dock(coordinator,previous,"right",{focus=false})
    if docked then ownerFloating=false end
    return docked
   end) then error("Coordinator could not dock") end
   retire(previous,sameTask)
  end
  if ticket.closeOrigin then
   if tonumber(ticket.closeOrigin)~=origin or
    (source.block~="tandem.board" and source.block~="tandem.usage" and source.block~="tandem.catchup" and source.block~="tandem.setup") then error("Return origin identity changed") end
   retire(origin)
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
   apply()
   local created=cx:new_block("tandem." .. ticket.kind,ticket.args,if ticket.placement=="window" then "tab" else "beside",{focus=ticket.placement~="panel",keep_open=false})
   -- nil means no Ready plugin defined the block, so Tern created nothing.
   if not created then run.applied-=1 end
   return created
  end)
  if not pane then error("Native block could not open") end
  if ticket.placement=="panel" then
   if not effect(function(cx) apply(); return cx.layout:move(pane,coordinator,"left",{focus=false}) end) then error("Panel could not move") end
   -- PaneInfo has no geometry, and daemon columns can remain 80 for hidden/native
   -- blocks. Calibrate against this window's usable layout after placement instead.
   type Geometry={ratio:number,span:number}
   local function panelGeometry(cx: WindowCx): Geometry
    local layout=cx.session:layout(owner.tab)
    local function find(tree: TabTree,span:number): Geometry?
     if tree.split=="right" and tree[1] and tree[1].pane==pane and tree.ratio then
      return {ratio=tree.ratio,span=span}
     end
     for index=1,2 do
      local child=tree[index]
      if child then
       local share=if tree.split=="right" and tree.ratio then (if index==1 then tree.ratio else 1-tree.ratio) else 1
       local geometry=find(child,span*share)
       if geometry then return geometry end
      end
     end
     return nil
    end
    local geometry=if layout then find(layout.root,1) else nil
    if not geometry or geometry.ratio<=0 or geometry.ratio>=1 or geometry.span<=0 then error("Panel divider unavailable") end
    return geometry
   end
   local before=effect(function(cx) return panelGeometry(cx) end)
   if not effect(function(cx) apply(); return cx.layout:resize(pane,"right",1) end) then error("Panel divider could not move") end
   local after=effect(function(cx) return panelGeometry(cx) end)
   local step=after.ratio-before.ratio
   if math.abs(step)<0.000001 or math.abs(after.span-before.span)>0.000001 then error("Panel geometry did not update consistently") end
   -- Tern's resize cell step uses the full usable window width, even for a nested
   -- divider. Account for every horizontal ancestor to keep the actual pane at 45 cells.
   local target=45*math.abs(step)/after.span
   local cells=math.round((target-after.ratio)/step)
   if cells~=0 and not effect(function(cx)
    local current=panelGeometry(cx)
    if math.abs(current.ratio-after.ratio)>0.000001 or math.abs(current.span-after.span)>0.000001 then error("Panel layout changed during sizing") end
    apply()
    return cx.layout:resize(pane,"right",cells)
   end) then error("Panel could not resize") end
   local actual=effect(function(cx) return panelGeometry(cx) end)
   if math.abs(actual.span-after.span)>0.000001 or math.abs(actual.ratio*actual.span-45*math.abs(step))>math.abs(step)*1.1 then error("Panel width could not be confirmed") end
   effect(function(cx) cx.layout:focus(coordinator) end)
  elseif ticket.placement=="task" then
   if not effect(function(cx)
    local current=cx.session:layout(owner.tab)
    if not current or #current.floats~=(if ownerFloating then 1 else 0)
     or (ownerFloating and current.floats[1].pane~=coordinator) then error("Task floating layout changed") end
    apply()
    local floated=cx.layout:float(coordinator,pane,"br",{focus=false})
    if floated then ownerFloating=true end
    return floated
   end) then error("Coordinator could not float") end
   if previous then retire(previous,sameTask) end
   effect(function(cx) cx.layout:focus(pane); apply(); cx:command("pip_stash_all") end)
   effect(function(cx) cx.layout:focus(pane) end)
  end
 end
 run.stage="confirm"
 local opened=pane :: number
 local tab=call(function(cx) return cx.session:tab_of(opened) end)
 if not tab then error("Opened view has no tab") end
 return {status="done",paneId=string.format("%.0f",opened),tabId=string.format("%.0f",tab),sessionId=ticket.session}
end

function M.open(req: OpenRequest, _cx: WindowCx): RouteDecision?
 local stem=string.match(req.path, "^(.*/tern/%x+/open/%x+%.[%x%-]+)%.ticket%.json$")
 if not stem then return nil end
 local receipt=stem .. ".receipt.json"
 local run: Run={stage="ticket",applied=0}
 local thread=coroutine.create(function() return host(req.path,receipt,run) end)
 -- Every exit writes the receipt exactly once: done with the opened pane, or failed with
 -- the stage and the effects already applied. The backend decides; nothing is retried.
 local settled=false
 local function finish(cx: WindowCx?, outcome: {[string]: any}, problem: string?)
  if settled then return end
  settled=true
  local wrote, failure=pcall(function() tern.fs.write(receipt,tern.json.encode(outcome)) end)
  local reason=problem or (if wrote then nil else tostring(failure))
  if reason and cx then cx:toast("error","Tandem view did not open",reason) end
 end
 local function fail(cx: WindowCx?, problem: any)
  finish(cx,{status="failed",stage=run.stage,appliedEffects=run.applied,reason=tostring(problem)},tostring(problem))
 end
 local function advance(cx: WindowCx?, value: any)
  local ok, step=coroutine.resume(thread,value)
  if not ok then return fail(cx,step) end
  if coroutine.status(thread)=="dead" then return finish(cx,step) end
  local scheduled, problem=pcall(tern.timer,step.delay,function(next: WindowCx?)
   if not next then return fail(nil,"Tern window closed before the view opened") end
   local ran, result=pcall(step.operation,next)
   if not ran then return fail(next,result) end
   advance(next,result)
  end)
  if not scheduled then fail(cx,problem) end
 end
 -- Consume the private ticket before any file read or native layout work.
 tern.timer(1,function(cx) advance(cx,nil) end)
 return {handled=true}
end
return M
