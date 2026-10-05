--!strict
-- Block `tandemwin.tasks`: polls a JSON file every second and renders clickable rows.
-- args[1] = path of the JSON (default /tmp/tern-window-test/tasks.json), args[2] = task id to select.
local ui = tern.ui
local DIR = "/tmp/tern-window-test"
local EVERY_MS = 1000

type Task = { id: string, title: string, stage: string, needs: string? }
type State = { path: string, raw: string, tasks: { Task }, sel: number, pane: number, ticks: number, last: string }

local function log(line: string)
	local f = DIR .. "/block-log.txt"
	local prior = if tern.fs.exists(f) then tern.fs.read(f) else ""
	tern.fs.write(f, prior .. line .. "\n")
end

local function running(pane: number): boolean
	for _, p in tern.pane.list() do
		if p.pane == pane then
			return true
		end
	end
	return false
end

local function wallms(cb: (string) -> ())
	tern.process.run({ "/usr/bin/perl", "-MTime::HiRes=time", "-e", "printf('%d',time*1000)" }, function(r)
		cb(r.stdout)
	end)
end

local function reload(state: State, cx: BlockCx)
	local ok, raw = pcall(tern.fs.read, state.path)
	if not ok then
		if state.raw ~= "<missing>" then
			state.raw = "<missing>"
			state.tasks = {}
			cx:render()
		end
		return
	end
	if raw == state.raw then
		return
	end
	state.raw = raw
	local dok, doc = pcall(tern.json.decode, raw)
	if dok and type(doc) == "table" then
		state.tasks = doc.tasks or {}
		state.last = tostring(doc.stamp or "")
	end
	cx:render()
	local stamp = state.last
	wallms(function(ms)
		log(string.format("render stamp=%s wall=%s delta=%s", stamp, ms, tostring((tonumber(ms) or 0) - (tonumber(stamp) or 0))))
	end)
end

local function approve(state: State, cx: BlockCx, id: string)
	local f = DIR .. "/approvals.jsonl"
	local prior = if tern.fs.exists(f) then tern.fs.read(f) else ""
	tern.fs.write(f, prior .. tern.json.encode({ approved = id }) .. "\n")
	cx:toast("success", "Approved " .. id, "written to approvals.jsonl")
end

local function clickable(node: Node, act: string): Node
	local p: { [string]: any } = node.p or {}
	p.actions = { click = act }
	node.p = p
	return node
end

local tasks: BlockDef<State> = {
	init = function(cx, args, _saved)
		local state: State = {
			path = args[1] or (DIR .. "/tasks.json"),
			raw = "",
			tasks = {},
			sel = 1,
			pane = cx.pane,
			ticks = 0,
			last = "",
		}
		if args[2] then
			state.sel = tonumber(args[2]) or 1
		end
		log("init pane=" .. tostring(cx.pane) .. " args=" .. table.concat(args, ","))
		local function tick()
			if not running(cx.pane) then
				return
			end
			state.ticks += 1
			reload(state, cx)
			tern.timer(EVERY_MS, tick)
		end
		tick()
		return state
	end,
	title = function(state)
		return "Tandem tasks (" .. #state.tasks .. ")"
	end,
	view = function(state, _cx)
		local items = {}
		for i, t in state.tasks do
			items[i] = {
				label = t.title,
				detail = { ui.span(t.stage, "muted") },
				value = if t.needs then { ui.span(t.needs, "warn") } else nil,
				icon = if t.needs then "bell" else "check",
				tone = if t.needs then "warn" else nil,
			}
		end
		local listing = ui.list(items)
		local children: { Node } = listing.c or {}
		for i, child in children do
			clickable(child, "select=" .. state.tasks[i].id)
			local p: { [string]: any } = child.p or {}
			p.key = "t" .. state.tasks[i].id
			child.p = p
		end
		local cur = state.tasks[state.sel]
		listing.p = {
			key = "items",
			selected = if cur then "main.items.t" .. cur.id else nil,
			empty = { ui.span("no tasks file", "muted") },
		}
		return {
			main = ui.col({ listing }),
			dock = ui.row({
				ui.text({ ui.span(state.path .. " · polled " .. state.ticks .. "x · stamp " .. state.last, "muted") }),
				clickable(ui.badge("Approve", "accent"), "approve=" .. (if cur then cur.id else "")),
			}),
		}
	end,
	key = function(state, key, cx)
		local n = #state.tasks
		if key.name == "j" or key.name == "down" then
			state.sel = math.min(state.sel + 1, math.max(n, 1))
		elseif key.name == "k" or key.name == "up" then
			state.sel = math.max(state.sel - 1, 1)
		elseif key.name == "a" or key.name == "enter" then
			local cur = state.tasks[state.sel]
			if cur then
				log("key approve " .. cur.id)
				approve(state, cx, cur.id)
			end
		else
			return false
		end
		return true
	end,
	event = function(state, ev, cx)
		log("event " .. tern.json.encode(ev))
		if ev.ev ~= "action" then
			return
		end
		if ev.act == "select" then
			for i, t in state.tasks do
				if t.id == ev.value then
					state.sel = i
				end
			end
		elseif ev.act == "approve" and ev.value ~= "" then
			approve(state, cx, ev.value)
		end
	end,
	save = function(state)
		return { path = state.path }
	end,
}

tern.block.define("tasks", tasks)
