--!nocheck
-- A recording stand-in for the Tern host API. The harness prepends json.luau and three tables:
-- MODULES (every tern-plugin/*.luau source, loaded unchanged), CONFIG and COMMANDS. The luau
-- CLI cannot read stdin incrementally, so each run replays every command from the start and
-- prints one result line per command; the harness checks earlier lines stay identical.

-- Window model. Layout trees use Tern's shape: leaves {pane=id}, splits {split="right", ratio, [1], [2]}.
local WIDTH = 200
-- Longer than the harness's settle window, so only a host that waits for absence sees it.
local CLOSE_DELAY_MS = 120
local clock = 0
local timers = {}
local timerSeq = 0
local panes = {}
local tabs = {}
local focused = nil
local definitions = {}
local mounted = {}
local paletteCommands = {}
local paletteOrder = {}
local routes = { open = nil, link = nil }
local handlers = { focus = {}, window_start = {} }
local files = {}
local processes = {}
local nextProcess = 0
local nextPane = CONFIG.firstPaneId
local nextTab = CONFIG.firstTabId
local faults = {}
local events = {}

local function emit(event) table.insert(events, event) end

local function findTab(id)
	for _, tab in tabs do if tab.id == id then return tab end end
	return nil
end

local function contains(tree, pane)
	if tree == nil then return false end
	if tree.pane ~= nil then return tree.pane == pane end
	return contains(tree[1], pane) or contains(tree[2], pane)
end

local function removeLeaf(tab, pane)
	local function strip(tree)
		if tree == nil then return nil end
		if tree.pane ~= nil then return if tree.pane == pane then nil else tree end
		local left, right = strip(tree[1]), strip(tree[2])
		if left == nil then return right end
		if right == nil then return left end
		tree[1], tree[2] = left, right
		return tree
	end
	tab.root = strip(tab.root)
end

local function splitAt(tab, target, pane, before)
	local leaf = { pane = pane }
	local function place(tree)
		if tree == nil then return nil end
		if tree.pane ~= nil then
			if tree.pane ~= target then return tree end
			return if before then { split = "right", ratio = 0.5, leaf, tree } else { split = "right", ratio = 0.5, tree, leaf }
		end
		tree[1], tree[2] = place(tree[1]), place(tree[2])
		return tree
	end
	if tab.root == nil or not contains(tab.root, target) then
		tab.root = if tab.root == nil then leaf else { split = "right", ratio = 0.5, tab.root, leaf }
	else
		tab.root = place(tab.root)
	end
end

local function lastLeaf(tree)
	if tree == nil then return nil end
	if tree.pane ~= nil then return tree.pane end
	return lastLeaf(tree[2]) or lastLeaf(tree[1])
end

local function sortedPaneIds()
	local ids = {}
	for id in panes do table.insert(ids, id) end
	table.sort(ids)
	return ids
end

local unmount

local function closePane(id, reported)
	local pane = panes[id]
	if not pane then return end
	local tab = findTab(pane.tab)
	if tab then removeLeaf(tab, id) end
	panes[id] = nil
	unmount(id)
	if focused == id then focused = nil end
	if reported then emit({ closed = id }) end
end

-- Module loading: production sources run unchanged with `tern`, `require` and a scenario clock.
local cache = {}
local fakeOs = { time = function() return math.floor((CONFIG.epochMs + clock) / 1000) end, clock = function() return clock / 1000 end, date = os.date }
local environment
local function load(name)
	local cached = cache[name]
	if cached ~= nil then return cached.value end
	local source = MODULES[name]
	if source == nil then error("no tern-plugin module " .. name, 2) end
	local chunk, problem = loadstring(source, "=tern-plugin/" .. string.sub(name, 3) .. ".luau")
	if not chunk then error(problem, 0) end
	setfenv(chunk, environment)
	local value = chunk()
	cache[name] = { value = value }
	return value
end

local function blockCx(id)
	local cx = { pane = id }
	function cx:render() end
	function cx:exit(code)
		emit({ exit = { pane = id, code = code } })
		closePane(id, true)
	end
	function cx:toast(level, title, message) emit({ toast = { pane = id, level = level, title = title, message = message } }) end
	function cx:open(url) emit({ open = { pane = id, url = url } }) end
	function cx:frame(operations) emit({ frame = { pane = id, operations = operations } }) end
	return cx
end

local function guarded(label, callback, ...)
	local ok, problem = pcall(callback, ...)
	if not ok then emit({ callbackError = { at = label, message = tostring(problem) } }) end
	return ok, problem
end

local function mount(id, kind, args)
	local name = string.match(kind, "^tandem%.(.+)$")
	local definition = name and definitions[name]
	if not definition then error("no Tandem block is defined as " .. kind, 0) end
	local cx = blockCx(id)
	local record = { kind = kind, definition = definition, cx = cx, args = args }
	mounted[id] = record
	local ok, state = guarded("init " .. kind, definition.init, cx, args, nil)
	if ok then record.state = state else mounted[id] = nil end
end

function unmount(id)
	mounted[id] = nil
end

local windowCx
local function paneInfo(id)
	local pane = panes[id]
	if not pane then return nil end
	return { tab = pane.tab, block = pane.block, floating = pane.floating, cwd = pane.cwd }
end

function windowCx()
	local cx = { session = {}, layout = {} }
	function cx.session:focused() return focused end
	function cx.session:pane(id) return paneInfo(id) end
	function cx.session:tabs()
		local result = {}
		for _, tab in tabs do table.insert(result, { id = tab.id, session = tab.session }) end
		return result
	end
	function cx.session:tab_of(id) return if panes[id] then panes[id].tab else nil end
	function cx.session:layout(id)
		local tab = findTab(id)
		if not tab then return nil end
		local floats = {}
		for _, paneId in sortedPaneIds() do
			local pane = panes[paneId]
			if pane.tab == id and pane.floating then table.insert(floats, { pane = paneId }) end
		end
		return { root = tab.root, floats = floats }
	end
	function cx.layout:focus(id)
		if not panes[id] then error("no pane " .. tostring(id)) end
		focused = id
	end
	function cx.layout:move(id, owner, direction)
		if faults.move then return false end
		local pane, target = panes[id], panes[owner]
		if not pane or not target or pane.tab ~= target.tab then return false end
		local tab = findTab(pane.tab)
		removeLeaf(tab, id)
		splitAt(tab, owner, id, direction == "left")
		return true
	end
	function cx.layout:resize(id, direction, cells)
		local pane = panes[id]
		if not pane or direction ~= "right" then return false end
		local function grow(tree)
			if tree == nil or tree.pane ~= nil then return false end
			if tree[1] and tree[1].pane == id then
				tree.ratio = math.clamp(tree.ratio + cells / WIDTH, 0.1, 0.9)
				return true
			end
			return grow(tree[1]) or grow(tree[2])
		end
		return grow(findTab(pane.tab).root)
	end
	-- Tern's raw close returns nothing and the session retires the pane later, so a closed
	-- pane stays listed past the current gesture's staged callbacks.
	function cx.layout:close(id)
		timerSeq += 1
		table.insert(timers, { due = clock + CLOSE_DELAY_MS, seq = timerSeq, callback = function() closePane(id, true) end })
	end
	function cx.layout:float(id)
		local pane = panes[id]
		if not pane then return false end
		removeLeaf(findTab(pane.tab), id)
		pane.floating = true
		return true
	end
	function cx.layout:dock(id, over)
		local pane = panes[id]
		if not pane or not panes[over] then return false end
		pane.floating = false
		splitAt(findTab(pane.tab), over, id, false)
		return true
	end
	function cx:new_block(kind, args, how, options)
		if faults.newBlock then return nil end
		local origin = panes[focused]
		if not origin then error("new_block needs a focused pane") end
		local id = nextPane
		nextPane += 1
		local tab
		if how == "tab" then
			tab = { id = nextTab, session = origin.session }
			nextTab += 1
			table.insert(tabs, tab)
		else
			tab = findTab(origin.tab)
		end
		panes[id] = { tab = tab.id, session = tab.session, block = kind, floating = false, cwd = origin.cwd }
		if how == "tab" then tab.root = { pane = id } else splitAt(tab, focused, id, false) end
		emit({ created = { id = id, tab = tab.id, session = tab.session, program = kind, args = args, cwd = origin.cwd } })
		if not options or options.focus ~= false then focused = id end
		mount(id, kind, args)
		return id
	end
	function cx:command(name) emit({ command = name }) end
	function cx:toast(level, title, message) emit({ toast = { level = level, title = title, message = message } }) end
	return cx
end

local ui = {}
function ui.node(kind, props, children) return { k = kind, p = props or {}, c = children } end
function ui.el(tag, props, children) return { k = "el", tag = tag, p = props or {}, c = children } end
function ui.text(spans) return { k = "text", p = {}, c = spans } end
function ui.span(text, tone) return { k = "span", p = { text = text, tone = tone } } end
function ui.md(text) return { k = "md", p = { text = text } } end
function ui.rule(text) return { k = "rule", p = { text = text } } end
function ui.row(children) return { k = "row", p = {}, c = children } end
function ui.col(children) return { k = "col", p = {}, c = children } end
function ui.card(head, body) return { k = "card", p = {}, c = { { k = "col", p = {}, c = head }, { k = "col", p = {}, c = body } } } end
function ui.meter(value, props) return { k = "meter", p = { value = value, props = props } } end

local tern = {
	ui = ui,
	json = json,
	now = function() return clock end,
	getenv = function(name) return CONFIG.env[name] end,
	timer = function(delay, callback)
		timerSeq += 1
		local timer = { due = clock + math.max(delay, 1), seq = timerSeq, callback = callback }
		table.insert(timers, timer)
		return { cancel = function() timer.cancelled = true end }
	end,
	fs = {
		read = function(path, limit)
			local text = files[path]
			if text == nil then error("ENOENT: no such file " .. path, 2) end
			if limit and #text > limit then error("file exceeds read limit " .. path, 2) end
			return text
		end,
		write = function(path, text)
			files[path] = text
			emit({ write = { path = path, text = text } })
		end,
	},
	pane = {
		list = function()
			local result = {}
			for _, id in sortedPaneIds() do table.insert(result, { pane = id }) end
			return result
		end,
	},
	process = {
		run = function(argv, options, callback)
			if faults.spawn then error("Could not spawn " .. tostring(argv[2]), 2) end
			nextProcess += 1
			processes[nextProcess] = callback
			emit({ process = { id = nextProcess, argv = argv, cwd = options and options.cwd, stdin = options and options.stdin } })
		end,
	},
	block = { define = function(name, definition) definitions[name] = definition end },
	command = function(spec)
		paletteCommands[spec.id] = spec
		table.insert(paletteOrder, spec.id)
	end,
	route = {
		open = function(callback) routes.open = callback end,
		link = function(callback) routes.link = callback end,
	},
	on = function(name, callback) table.insert(handlers[name], callback) end,
}
environment = setmetatable({ tern = tern, require = load, os = fakeOs }, { __index = getfenv(1) })

local function serializeView(view)
	if type(view) ~= "table" then return view end
	return { main = view.main, dock = view.dock, layer = view.layer }
end

local function block(id)
	local record = mounted[id]
	if not record then error("no mounted block in pane " .. tostring(id), 0) end
	return record
end

local operations = {}
function operations.boot()
	for _, entry in CONFIG.entries do load(entry) end
end
function operations.sync(command)
	local present = {}
	for _, entry in command.panes do
		present[entry.id] = true
		if not panes[entry.id] then
			local tab = findTab(entry.tab)
			if not tab then
				tab = { id = entry.tab, session = entry.session }
				table.insert(tabs, tab)
			end
			panes[entry.id] = { tab = entry.tab, session = entry.session, block = entry.block, floating = false, cwd = entry.cwd }
			splitAt(tab, lastLeaf(tab.root), entry.id, false)
		end
	end
	for _, id in sortedPaneIds() do if not present[id] then closePane(id, false) end end
	for path, text in command.files do
		files[path] = if text == false then nil else text
	end
end
function operations.advance(command)
	local stop = clock + command.ms
	while true do
		table.sort(timers, function(a, b) return if a.due == b.due then a.seq < b.seq else a.due < b.due end)
		local timer = timers[1]
		if not timer or timer.due > stop then break end
		table.remove(timers, 1)
		clock = math.max(clock, timer.due)
		if not timer.cancelled then guarded("timer", timer.callback, windowCx()) end
	end
	clock = stop
end
function operations.render(command)
	local record = block(command.pane)
	local ok, view = guarded("view " .. record.kind, record.definition.view, record.state, record.cx)
	local title = if record.definition.title then record.definition.title(record.state) else nil
	emit({ view = { pane = command.pane, kind = record.kind, title = title, tree = if ok then serializeView(view) else nil } })
end
function operations.action(command)
	local record = block(command.pane)
	local act, value = string.match(command.action, "^([^=]*)=(.*)$")
	local event = { ev = "action", act = act or command.action, value = value }
	guarded("event " .. record.kind, record.definition.event, record.state, event, record.cx)
end
function operations.event(command)
	local record = block(command.pane)
	guarded("event " .. record.kind, record.definition.event, record.state, command.event, record.cx)
end
function operations.key(command)
	local record = block(command.pane)
	local handled = false
	if record.definition.key then
		local _, result = guarded("key " .. record.kind, record.definition.key, record.state, command.key, record.cx)
		handled = result == true
	end
	emit({ key = { name = command.key.name, handled = handled } })
end
function operations.type(command)
	local record = block(command.pane)
	for _, code in utf8.codes(command.text) do
		local char = utf8.char(code)
		guarded("key " .. record.kind, record.definition.key, record.state, { name = char, text = char }, record.cx)
	end
end
function operations.result(command)
	local callback = processes[command.id]
	if not callback then error("no process " .. tostring(command.id), 0) end
	processes[command.id] = nil
	guarded("process callback", callback, { status = command.status, stdout = command.stdout, stderr = command.stderr })
end
function operations.route(command)
	local decision
	if routes.open then
		local _, result = guarded("route.open", routes.open, { path = command.path }, windowCx())
		decision = result
	end
	emit({ route = { handled = type(decision) == "table" and decision.handled == true } })
end
function operations.link(command)
	local decision
	if routes.link then
		local _, result = guarded("route.link", routes.link, { url = command.url }, windowCx())
		decision = result
	end
	emit({ link = { handled = type(decision) == "table" and decision.handled == true } })
end
function operations.commands()
	local listed = {}
	for _, id in paletteOrder do
		local spec = paletteCommands[id]
		table.insert(listed, { id = id, title = spec.title, visible = spec.available == nil or spec.available(windowCx()) == true })
	end
	emit({ commands = json.array(listed) })
end
function operations.command(command)
	local spec = paletteCommands[command.id]
	if not spec then error("no palette command " .. command.id, 0) end
	guarded("command " .. command.id, spec.run, windowCx())
end
function operations.focus(command)
	focused = command.pane
	for _, callback in handlers.focus do guarded("focus", callback, { pane = command.pane }, windowCx()) end
end
function operations.windowStart()
	for _, callback in handlers.window_start do guarded("window_start", callback, windowCx()) end
end
function operations.fault(command)
	faults[command.name] = command.enabled
end

for index, command in COMMANDS do
	events = {}
	local operation = operations[command.op]
	local ok, problem = pcall(operation, command)
	local line = { events = json.array(events) }
	if not ok then line.error = tostring(problem) end
	for _, timer in timers do
		if not timer.cancelled and (line.next == nil or timer.due - clock < line.next) then line.next = timer.due - clock end
	end
	print("@@" .. index .. "\t" .. json.encode(line))
end
