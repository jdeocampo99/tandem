--!nonstrict
-- Window half: opens the lab block, and the CSS the own-rows diff needs (hover, gutter, add/del colors).
local DIR = "/tmp/tern-ui-probe"

tern.css("tp", [[
.tp-row { display:flex; align-items:flex-start; gap:8px; padding:0 6px; border-left:3px solid transparent; }
.tp-row:hover { background: rgba(120,160,255,0.16); border-left-color:#7aa2ff; }
.tp-row.tp-add { background: rgba(60,180,90,0.12); }
.tp-row.tp-del { background: rgba(220,70,70,0.14); }
.tp-gut { width:4ch; text-align:right; opacity:0.5; flex:none; }
.tp-plus { width:2ch; flex:none; text-align:center; opacity:0; background:#3b82f6; color:white; border-radius:4px; }
.tp-row:hover .tp-plus { opacity:1; }
.tp-code { flex:1; white-space:pre; }
.tp-rail { width:34ch; flex:none; }
.tp-card { border:1px solid rgba(255,200,80,0.6); border-radius:6px; padding:4px 8px; background:rgba(255,200,80,0.08); }
.tp-thread { margin:2px 6px 6px 8ch; border:1px solid rgba(255,200,80,0.6); border-radius:6px; padding:4px 8px; background:rgba(255,200,80,0.08); }
.tp-tab { padding:0 8px; }
]])

tern.command({
	id = "open_lab",
	title = "UI probe: open lab block",
	keys = { "ctrl+alt+shift+u" },
	run = function(cx)
		local pane = cx:new_block("tuiprobe.lab", {}, "beside")
		local f = DIR .. "/window-log.txt"
		local prior = if tern.fs.exists(f) then tern.fs.read(f) else ""
		tern.fs.write(f, prior .. "open_lab pane=" .. tostring(pane) .. "\n")
	end,
})
