--!strict
-- Common CLI calling convention for screen renderers. No durable state or retries.
local M = {}
-- `ctx` is Tandem's opaque launch context. Blocks never read it; every action echoes it back.
-- `index` is the project's root index file, which detail views also watch.
export type Origin = {path:string, ctx:string, index:string}
-- Only the known catch-up warning on a proven successful entry permits callback exit.
-- Retention and unknown warnings keep the originating pane open.
function M.warnings(stdout: string): ({string}, boolean)
 local messages: {string} = {}
 local decoded,value=pcall(function() return tern.json.decode(stdout) end)
 if not decoded or type(value)~="table" then return messages,false end
 local complete=true
 if type(value.warnings)=="table" then
  local entered=value.entered==true or value.focused==true
  local catchUpPrefix="Project opened, but catch-up is unavailable: "
  for _,message in value.warnings do
   if type(message)=="string" then
    table.insert(messages,message)
    if not entered or string.sub(message,1,#catchUpPrefix)~=catchUpPrefix then complete=false end
   else complete=false end
  end
 elseif value.warnings~=nil then complete=false end
 return messages,complete
end
function M.origin(args: {string}): Origin
 return {path=args[1] or "",ctx=args[2] or "",index=args[3] or ""}
end
-- Appends this block's origin to an action's argv: its exact pane and the echoed context.
function M.context(argv: {string}, origin: Origin, cx: BlockCx)
 table.insert(argv,"--pane"); table.insert(argv,string.format("%.0f",cx.pane))
 table.insert(argv,"--ctx"); table.insert(argv,origin.ctx)
end
function M.run(origin: Origin, cx: BlockCx, args: {string}, onSuccess: (() -> ())?)
 local argv={"/bin/sh","tandem.sh","native"}
 for _, arg in args do table.insert(argv,arg) end
 M.context(argv,origin,cx)
 local ok,problem=pcall(function()
  tern.process.run(argv,{cwd="."},function(result)
   if result.status~=0 then cx:toast("error","Tandem couldn't run that action",result.stderr)
   else
    local warnings,complete=M.warnings(result.stdout)
    if #warnings>0 then cx:toast("warning",if complete then "Tandem action completed" else "Tandem kept an uncertain view",table.concat(warnings,"\n")) end
    if complete and onSuccess then onSuccess() end
   end
  end)
 end)
 if not ok then cx:toast("error","Tandem couldn't start that action",tostring(problem)) end
end
function M.root(origin: Origin): string
 return origin.index
end
function M.back(origin: Origin,cx: BlockCx,onSuccess: (() -> ())?)
 M.run(origin,cx,{"view-file",M.root(origin) .. "#orchestrator"},onSuccess)
end
return M
