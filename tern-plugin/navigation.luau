--!strict
-- Common CLI calling convention for screen renderers. No durable state or retries.
local M = {}
export type Origin = {path:string, coordinator:string, cwd:string, window:string, indexPath:string, home:string}
-- Successful native actions may carry presentation warnings without failing navigation.
function M.warnings(stdout: string): {string}
 local messages: {string} = {}
 local decoded,value=pcall(function() return tern.json.decode(stdout) end)
 if decoded and type(value)=="table" and type(value.warnings)=="table" then
  for _,message in value.warnings do if type(message)=="string" then table.insert(messages,message) end end
 end
 return messages
end
function M.origin(args: {string}): Origin
 local indexPath=args[5] or ""
 local home=string.match(indexPath,"^(.*)/native%-views/[^/]+%.json$") or ""
 return {path=args[1] or "",coordinator=args[2] or "",cwd=args[3] or "",window=args[4] or "",indexPath=indexPath,home=home}
end
function M.run(origin: Origin, cx: BlockCx, args: {string}, onSuccess: (() -> ())?)
 if string.sub(origin.cwd,1,1)~="/" or string.sub(origin.home,1,1)~="/" then cx:toast("error","Tandem action unavailable","Originating cwd or index path is missing"); return end
 local argv={"/bin/sh","tandem.sh","native"}
 for _, arg in args do table.insert(argv,arg) end
 if origin.home~="" then table.insert(argv,"--home"); table.insert(argv,origin.home) end
 table.insert(argv,"--pane"); table.insert(argv,string.format("%.0f",cx.pane))
 table.insert(argv,"--cwd"); table.insert(argv,origin.cwd)
 if origin.window~="" then table.insert(argv,"--window"); table.insert(argv,origin.window) end
 local ok,problem=pcall(function()
  tern.process.run(argv,{cwd="."},function(result)
   if result.status~=0 then cx:toast("error","Tandem couldn't run that action",result.stderr)
   else
    local warnings=M.warnings(result.stdout)
    if #warnings>0 then cx:toast("warning","Tandem action completed",table.concat(warnings,"\n")) end
    if onSuccess then onSuccess() end
   end
  end)
 end)
 if not ok then cx:toast("error","Tandem couldn't start that action",tostring(problem)) end
end
function M.root(origin: Origin): string
 return origin.indexPath
end
function M.back(origin: Origin,cx: BlockCx,onSuccess: (() -> ())?)
 M.run(origin,cx,{"view-file",M.root(origin) .. "#orchestrator"},onSuccess)
end
return M
