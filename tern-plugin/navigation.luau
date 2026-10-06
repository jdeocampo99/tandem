--!strict
-- Common CLI calling convention for screen renderers. No durable state or retries.
local M = {}
export type Origin = {path:string, coordinator:string, cwd:string, window:string, home:string}
function M.origin(args: {string}): Origin
 return {path=args[1] or "",coordinator=args[2] or "",cwd=args[3] or "",window=args[4] or "",home=args[5] or ""}
end
function M.run(origin: Origin, cx: BlockCx, args: {string})
 if string.sub(origin.cwd,1,1)~="/" then cx:toast("error","Tandem action unavailable","Originating cwd is missing"); return end
 local argv={"/bin/sh","tandem.sh","native"}
 for _, arg in args do table.insert(argv,arg) end
 table.insert(argv,"--pane"); table.insert(argv,string.format("%.0f",cx.pane))
 table.insert(argv,"--cwd"); table.insert(argv,origin.cwd)
 if origin.window~="" then table.insert(argv,"--window"); table.insert(argv,origin.window) end
 local ok,problem=pcall(function()
  tern.process.run(argv,{cwd="."},function(result)
   if result.status~=0 then cx:toast("error","Tandem couldn't run that action",result.stderr) end
  end)
 end)
 if not ok then cx:toast("error","Tandem couldn't start that action",tostring(problem)) end
end
function M.root(origin: Origin): string
 local root=string.match(origin.path,"^(.*)/[^/]+/[^/]+%.json$")
 if string.match(origin.path,"/native%-views/[^/]+/[^/]+%.json$") and root then
  local project=string.match(origin.path,"/native%-views/([^/]+)/")
  return root .. "/" .. project .. ".json"
 end
 return origin.path
end
function M.back(origin: Origin,cx: BlockCx)
 M.run(origin,cx,{"view-file",M.root(origin) .. "#orchestrator"})
end
return M
