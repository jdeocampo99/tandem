--!strict
-- Only immutable backend-authored opening tickets can reach the native layout API.
local M = {}
local kinds = { panel=true, task=true, brief=true, pr=true, prs=true, board=true, usage=true, catchup=true, welcome=true }
function M.open(req: OpenRequest, cx: WindowCx): RouteDecision?
 if not string.match(req.path, "/native%-host/[%w%-]+%.tandem%-open%.json$") then return nil end
 local ok, ticket = pcall(function() return tern.json.decode(tern.fs.read(req.path, 16384)) end)
 if not ok or type(ticket) ~= "table" or ticket.version ~= 1 or not kinds[ticket.kind]
  or type(ticket.args) ~= "table" or #ticket.args ~= 5 or type(ticket.receipt) ~= "string"
  or not string.match(ticket.receipt, "/native%-host/[%w%-]+%.receipt%.json$") then
  cx:toast("error", "Tandem view did not open", "Invalid opening ticket")
  return {handled=true}
 end
 local coordinator = tonumber(ticket.coordinator)
 local origin = tonumber(ticket.origin)
 local owner = if coordinator then cx.session:pane(coordinator) else nil
 local source = if origin then cx.session:pane(origin) else nil
 if not owner or not source or not owner.tab or not source.tab then
  cx:toast("error", "Tandem view did not open", "Exact originating panes disappeared")
  return {handled=true}
 end
 local session = tonumber(ticket.session)
 local same, sameOrigin = false, false
 for _, tab in cx.session:tabs() do
  if tab.id == owner.tab and tab.session == session then same=true end
  if tab.id == source.tab and tab.session == session then sameOrigin=true end
 end
 if not same or not sameOrigin then return {handled=true} end
 local pane: number?
 local previous=if ticket.replaced then tonumber(ticket.replaced) else nil
 if ticket.placement=="inbox" then
  cx:command("inbox")
  pane=origin
 elseif ticket.placement=="return" then
  if owner.floating then
   local old=if previous then cx.session:pane(previous) else nil
   local layout=cx.session:layout(owner.tab)
   if not old or old.block~="tandem.task" or old.tab~=owner.tab or old.floating
    or not layout or #layout.floats~=1 or layout.floats[1].pane~=coordinator then return {handled=true} end
   if not cx.layout:dock(coordinator,previous,"right",{focus=false}) then return {handled=true} end
   cx.layout:close(previous)
  end
  if ticket.closeOrigin then
   if tonumber(ticket.closeOrigin)~=origin or
    (source.block~="tandem.board" and source.block~="tandem.usage" and source.block~="tandem.catchup") then return {handled=true} end
   cx.layout:close(origin)
  end
  cx.layout:focus(coordinator)
  pane=coordinator
 else
  if ticket.placement=="task" then
   local layout=cx.session:layout(owner.tab)
   if not layout then return {handled=true} end
   if owner.floating then
    local old=if previous then cx.session:pane(previous) else nil
    if #layout.floats~=1 or layout.floats[1].pane~=coordinator or not old
     or old.tab~=owner.tab or old.block~="tandem.task" or old.floating then return {handled=true} end
   elseif #layout.floats>0 or previous then return {handled=true} end
  end
  cx.layout:focus(if ticket.placement=="task" and owner.floating then previous else coordinator)
  pane=cx:new_block("tandem." .. ticket.kind,ticket.args,if ticket.placement=="window" then "tab" else "beside",{focus=ticket.placement~="panel",keep_open=false})
  if not pane then return {handled=true} end
  if ticket.placement=="panel" then
   if not cx.layout:move(pane,coordinator,"left",{focus=false}) then return {handled=true} end
   cx.layout:resize(pane,"right",45-math.floor((ticket.columns or 90)/2))
   cx.layout:focus(coordinator)
  elseif ticket.placement=="task" then
   if not cx.layout:float(coordinator,pane,"br",{focus=false}) then return {handled=true} end
   if previous then cx.layout:close(previous) end
   cx:command("pip_stash_all")
   cx.layout:focus(pane)
  end
 end
 local tab=if pane then cx.session:tab_of(pane) else nil
 if pane and tab then tern.fs.write(ticket.receipt,tern.json.encode({paneId=string.format("%.0f",pane),tabId=string.format("%.0f",tab),sessionId=ticket.session})) end
 return {handled=true}
end
return M
