--!strict
-- Window half: status segment, key bind, palette commands, toasts, routes.
local DIR = "/tmp/tern-window-test"
local TASKS = DIR .. "/tasks.json"
local clicks = 0

local function log(line: string)
	local f = DIR .. "/window-log.txt"
	local prior = if tern.fs.exists(f) then tern.fs.read(f) else ""
	tern.fs.write(f, prior .. line .. "\n")
end

tern.command({
	id = "open_tasks",
	title = "Tandem probe: open tasks block",
	icon = "list",
	keys = { "ctrl+alt+shift+t" },
	run = function(cx)
		local pane = cx:new_block("tandemwin.tasks", { TASKS }, "beside")
		log("open_tasks pane=" .. tostring(pane))
		cx:toast("success", "tasks block opened", "pane " .. tostring(pane))
	end,
})

tern.command({
	id = "ping",
	title = "Tandem probe: ping (toast)",
	run = function(cx)
		log("ping")
		cx:toast("info", "ping from palette command", "second line")
		cx:toast("error", "error toast", "level error")
	end,
})

tern.command({
	id = "status_click",
	title = "Tandem probe: status clicked",
	run = function(cx)
		clicks += 1
		log("status_click " .. clicks)
		cx:toast("info", "status segment clicked", tostring(clicks) .. " clicks")
		tern.chrome.refresh()
	end,
})

tern.bind("ctrl+alt+shift+k", function(cx)
	log("bind fn fired")
	cx:toast("success", "key bind fired")
end)

tern.chrome.status(function(_pane)
	return { { text = "tandem 2 need you · " .. clicks, icon = "bell", tone = "warn", command = "plugin.tandemwin.status_click" } }
end)

tern.route.link(function(link, cx)
	log("route.link " .. link.url)
	local id = string.match(link.url, "^tandem://task/([%w%-]+)$")
	if id then
		cx:toast("info", "tandem:// route", id)
		return { block = "tandemwin.tasks", args = { TASKS, id } }
	end
	return nil
end)

tern.route.open(function(req, cx)
	log("route.open " .. req.path .. " origin=" .. req.origin)
	if string.match(req.path, "%.tandemtasks%.json$") then
		return { block = "tandemwin.tasks", args = { req.path } }
	end
	if string.match(req.path, "%.board%.md$") then
		cx.board:open(req.path, { how = "beside" })
		return { handled = true }
	end
	return nil
end)

tern.on("window_start", function(cx)
	log("window_start")
	cx:toast("info", "tandemwin window_start")
end)
