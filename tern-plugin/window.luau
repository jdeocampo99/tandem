--!strict
-- Window routing only. The CLI owns state, project lookup, opening views, and every action guard.
local function run(cx: WindowCx, args: { string })
 local argv = { "/bin/sh", "tandem.sh", "native" }
 for _, arg in args do table.insert(argv, arg) end
 local pane = cx.session:focused()
 local info = if pane then cx.session:pane(pane) else nil
 if not pane or not info or not info.cwd or string.sub(info.cwd, 1, 1) ~= "/" then
  cx:toast("error", "Tandem couldn't run that action", "The originating pane and its absolute cwd are required.")
  return
 end
 table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", pane))
 table.insert(argv, "--cwd"); table.insert(argv, info.cwd)
 local window = tern.getenv("TERN_WINDOW_KEY")
 if window and window ~= "" then table.insert(argv, "--window"); table.insert(argv, window) end
 local ok, problem = pcall(function()
  tern.process.run(argv, { cwd = "." }, function(result, callbackCx)
   if result.status ~= 0 and callbackCx then
    callbackCx:toast("error", "Tandem couldn't run that action", result.stderr)
   end
  end)
 end)
 if not ok then cx:toast("error", "Tandem couldn't start that action", tostring(problem)) end
end

local function command(id: string, title: string, args: { string })
 tern.command({ id = id, title = title, run = function(cx) run(cx, args) end })
end

command("new-request", "Tandem: New request…", { "new-request" })
command("open-task", "Tandem: Open task…", { "open-task" })
command("board", "Tandem: Toggle board", { "board" })
command("prs", "Tandem: Show PRs", { "prs" })
command("usage", "Tandem: Usage", { "usage" })

for number = 1, 9 do
 local value = tostring(number)
 command("project-" .. value, "Tandem: Project " .. value, { "project", value })
end
command("project-prev", "Tandem: Previous project", { "project", "prev" })
command("project-next", "Tandem: Next project", { "project", "next" })

tern.route.link(function(link, cx)
 local kind, id = string.match(link.url, "^tandem://([a-z]+)/([%w_-]+)$")
 if kind == "task" or kind == "brief" or (kind == "pr" and id and string.match(id, "^%d+$")) then
  run(cx, { "open", kind, id })
  return { handled = true }
 end
 return nil
end)

tern.route.open(function(req, cx)
 if string.match(req.path, "%.tandem%-view%.json$") then
  run(cx, { "view-file", req.path })
  return { handled = true }
 end
 return nil
end)
