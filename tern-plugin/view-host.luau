--!strict
-- Only immutable backend-authored opening tickets can reach the native layout API.
local M = {}
local kinds = { panel=true, task=true, brief=true, pr=true, prs=true, board=true, usage=true, catchup=true, welcome=true, ["task-picker"]=true }
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
 local same = false
 for _, tab in cx.session:tabs() do if tab.id == owner.tab and tab.session == session then same=true end end
 if not same then return {handled=true} end
 local pane: number?
 if ticket.placement=="inbox" then
  cx:command("inbox")
  pane=origin
 elseif ticket.placement=="return" then
  if source.block=="tandem.task-picker" and not owner.floating then
   -- A picker is a disposable split; returning never docks or closes the coordinator.
  elseif source.block=="tandem.task" and owner.floating then
   if not cx.layout:dock(coordinator,origin,"right",{focus=false}) then return {handled=true} end
  else return {handled=true} end
  cx.layout:close(origin)
  cx.layout:focus(coordinator)
  pane=coordinator
 else
  if ticket.placement=="task" then
   local layout=cx.session:layout(owner.tab)
   if owner.floating or not layout or #layout.floats>0 then return {handled=true} end
  end
  cx.layout:focus(coordinator)
  pane=cx:new_block("tandem." .. ticket.kind,ticket.args,if ticket.placement=="window" then "tab" else "beside",{focus=ticket.placement~="panel"})
  if not pane then return {handled=true} end
  if ticket.placement=="panel" then
   if not cx.layout:move(pane,coordinator,"left",{focus=false}) then return {handled=true} end
   cx.layout:resize(pane,"right",45-math.floor((ticket.columns or 90)/2))
   cx.layout:focus(coordinator)
  elseif ticket.placement=="task" then
   if not cx.layout:float(coordinator,pane,"br",{focus=false}) then return {handled=true} end
   cx:command("pip_stash_all")
   cx.layout:focus(pane)
  end
 end
 local tab=if pane then cx.session:tab_of(pane) else nil
 if pane and tab then tern.fs.write(ticket.receipt,tern.json.encode({paneId=string.format("%.0f",pane),tabId=string.format("%.0f",tab),sessionId=ticket.session})) end
 return {handled=true}
end
return M
