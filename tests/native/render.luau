--!nocheck
-- Runs the production plugin's blocks against files Tandem wrote. The test prepends the parity
-- stand-ins' json.luau, MODULES (every tern-plugin/*.luau source) and CASES. Each case mounts one block in its own
-- pane; each step replaces files, fires the pending timers once and draws the block.

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

local files = {}
local timers = {}
local definitions = {}
local current = 0

local tern = {
	ui = ui,
	json = json,
	now = function() return 0 end,
	getenv = function() return nil end,
	timer = function(_, callback)
		local timer = { callback = callback }
		table.insert(timers, timer)
		return { cancel = function() timer.cancelled = true end }
	end,
	fs = {
		read = function(path)
			local text = files[path]
			if text == nil then error("ENOENT: no such file " .. path, 2) end
			return text
		end,
		write = function() end,
	},
	pane = { list = function() return { { pane = current } } end },
	process = { run = function() end },
	block = { define = function(name, definition) definitions[name] = definition end },
	command = function() end,
	route = { open = function() end, link = function() end },
	on = function() end,
}

local cache = {}
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
environment = setmetatable({ tern = tern, require = load }, { __index = getfenv(1) })
load("./host")

for index, case in CASES do
	current = index
	timers = {}
	files = {}
	local definition = definitions[case.block]
	local cx = { pane = index }
	function cx:render() end
	function cx:toast() end
	function cx:exit() end
	function cx:open() end
	function cx:frame() end
	local state
	for step, changes in case.steps do
		for path, text in changes do files[path] = if text == false then nil else text end
		if step == 1 then
			state = definition.init(cx, case.args, nil)
		end
		local due = timers
		timers = {}
		for _, timer in due do
			if not timer.cancelled then timer.callback({}) end
		end
		local ok, view = pcall(definition.view, state, cx)
		local line = { title = definition.title(state) }
		if ok then line.tree = { main = view.main, dock = view.dock, layer = view.layer } else line.error = tostring(view) end
		print("@@" .. index .. "\t" .. step .. "\t" .. json.encode(line))
	end
end
