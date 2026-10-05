--!strict
-- Window routing only. The CLI owns state, project lookup, opening views, and every action guard.
local function run(cx: WindowCx, args: { string })
 local argv = { "/bin/sh", "tandem.sh", "native" }
 for _, arg in args do table.insert(argv, arg) end
 local pane = cx.session:focused()
 if pane then table.insert(argv, "--pane"); table.insert(argv, string.format("%.0f", pane)) end
 local info = if pane then cx.session:pane(pane) else nil
 if info and info.cwd and info.cwd ~= "" then table.insert(argv, "--cwd"); table.insert(argv, info.cwd) end
 local window = tern.getenv("TERN_WINDOW_KEY")
 if window and window ~= "" then table.insert(argv, "--window"); table.insert(argv, window) end
 tern.process.run(argv, { cwd = "." }, function(result, callbackCx)
  if result.status ~= 0 and callbackCx then
   callbackCx:toast("error", "Tandem couldn't run that action", result.stderr)
  end
 end)
end

local function command(id: string, title: string, args: { string }, keys: { string }?)
 tern.command({ id = id, title = title, keys = keys, run = function(cx) run(cx, args) end })
end

command("new-request", "Tandem: New request…", { "new-request" })
command("open-task", "Tandem: Open task…", { "open-task" })
command("board", "Tandem: Toggle board", { "board" }, { "cmd+shift+b" })
command("prs", "Tandem: Show PRs", { "prs" }, { "cmd+shift+p" })
command("usage", "Tandem: Usage", { "usage" }, { "cmd+shift+u" })

for number = 1, 9 do
 local value = tostring(number)
 -- Keep this registration order: settings keybinds name Tern's bind.0 through bind.10 actions.
 tern.bind("cmd+" .. value, function(cx) run(cx, { "project", value }) end)
end
tern.bind("cmd+shift+[", function(cx) run(cx, { "project", "prev" }) end)
tern.bind("cmd+shift+]", function(cx) run(cx, { "project", "next" }) end)

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
