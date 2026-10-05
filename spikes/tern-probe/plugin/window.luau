tern.command({
	id = "open_panel",
	title = "Tandem probe: open panel",
	keys = { "ctrl+alt+shift+p" },
	run = function(cx)
		local pane = cx:new_block("tandemprobe.panel", { "from-command" }, "beside", nil)
		cx:toast("success", "tandem-probe toast", "panel pane " .. tostring(pane))
	end,
})

tern.bind("ctrl+alt+shift+o", "plugin.tandemprobe.open_panel")

tern.chrome.status(function()
	return { { text = "tandem-probe status", tone = "muted", command = "plugin.tandemprobe.open_panel" } }
end)

tern.on("window_start", function(cx)
	cx:toast("info", "tandem-probe window_start")
end)
