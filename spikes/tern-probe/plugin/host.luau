-- The probe passes TANDEM_PROBE_HOST_LOG in the isolated daemon's environment.
local out = tern.getenv("TANDEM_PROBE_HOST_LOG")

local function record(kind, ev)
	if out == nil then
		return
	end
	local prior = if tern.fs.exists(out) then tern.fs.read(out) else ""
	tern.fs.write(out, prior .. tern.json.encode({ kind = kind, ev = ev }) .. "\n")
end

record("loaded", { context = tern.context, plugin = tern.plugin, panes = tern.json.array(tern.pane.list()) })

for _, name in { "command_started", "command_finished", "cwd", "title" } do
	tern.on(name, function(ev)
		record(name, ev)
	end)
end

tern.on("pane_exited", function(ev, cx)
	record("pane_exited", ev)
	local ok, err = pcall(function()
		cx:toast("info", "tandem-probe: pane exited", tostring(ev.pane))
	end)
	record("host_toast", { ok = ok, err = if ok then tern.json.null else tostring(err) })
end)

tern.block.define("panel", {
	init = function(cx, args, saved)
		return { args = args, opened = saved ~= nil }
	end,
	view = function(state)
		return { main = tern.ui.text({ tern.ui.span("tandem-probe panel " .. table.concat(state.args, ",")) }) }
	end,
	title = function()
		return "Tandem probe panel"
	end,
	save = function(state)
		return { args = state.args }
	end,
})
