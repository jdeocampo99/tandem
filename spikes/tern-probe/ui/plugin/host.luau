--!nonstrict
local ui = tern.ui
local DIR = "/tmp/tern-ui-probe"
local LOG = DIR .. "/block-log.txt"
local PR = "https://github.com/jdeocampo99/tandem/pull/281"

local function log(line)
	local prior = if tern.fs.exists(LOG) then tern.fs.read(LOG) else ""
	tern.fs.write(LOG, prior .. line .. "\n")
end

local MODES = { "input", "diff", "diff2", "rows", "md", "layer", "motion", "link" }

local PATCH = table.concat({
	"diff --git a/compose.ts b/compose.ts",
	"--- a/compose.ts",
	"+++ b/compose.ts",
	"@@ -1,5 +1,8 @@",
	" import { herdr } from './herdr';",
	"-const backend = herdr();",
	"+export function pickBackend(env: Env): TerminalBackend {",
	"+  return env.terminal === 'herdr'",
	"+    ? herdrBackend(env)",
	"+    : fail('no terminal backend');",
	"+}",
	" export const x = 1;",
	" export const y = 2;",
	"@@ -40,3 +43,4 @@ function other()",
	"   const a = 1;",
	"-  const b = 2;",
	"+  const b = 3;",
	"+  const c = 4;",
}, "\n")

local MD = table.concat({
	"# Terminal port refactor",
	"",
	"Extracts a **TerminalBackend** port so `compose.ts` is the one place a backend is picked.",
	"",
	"## Changes",
	"",
	"- Add `terminal-backend/contract.ts`",
	"- Move Herdr code under `terminal-backend/herdr/`",
	"- Restrict Herdr imports with Biome",
	"",
	"Second paragraph with a [link](https://example.com) and `inline code`.",
	"",
	"```ts",
	"const x: number = 1;",
	"```",
}, "\n")

local function mdParas()
	local out = {}
	for chunk in string.gmatch(MD .. "\n\n", "(.-)\n\n") do
		table.insert(out, chunk)
	end
	return out
end

local function btn(text, act, tone)
	return ui.node("badge", { text = text, tone = tone or "muted", actions = { click = act } })
end

local function codeNode(s)
	return ui.node("text", { spans = { ui.span(s, "") }, wrap = "none", grow = 1 })
end

local function fakeLines()
	local t = {}
	for i = 1, 300 do
		local kind = if i % 7 == 0 then "add" elseif i % 11 == 0 then "del" else "ctx"
		table.insert(t, { n = i, kind = kind, code = (if kind == "add" then "+ " elseif kind == "del" then "- " else "  ") .. "const value" .. i .. " = compute(" .. i .. ", options.flag" .. (i % 5) .. ");" })
	end
	return t
end

local lab: BlockDef<any> = {
	init = function(cx, args, _saved)
		return {
			mode = "input", pane = cx.pane,
			inp = "", inpCur = 0, ed = "", edCur = 0, field = "inp",
			submitted = "", cancelled = 0, jcount = 0, lastKey = "", lastEv = "",
			open = {}, sel = 1, lines = fakeLines(), viewN = 0, lastViewMs = 0,
			overlay = false, started = os.clock(), linkClicks = 0, mdClicks = "",
		}
	end,
	title = function(s) return "UI lab: " .. s.mode end,
	view = function(s, cx)
		s.viewN += 1
		local t0 = os.clock()
		local tabs = {}
		for _, m in MODES do
			tabs[#tabs + 1] = btn(m, "mode=" .. m, if m == s.mode then "accent" else "muted")
		end
		local dock = ui.col({ ui.row(tabs), ui.text({ ui.span("view#" .. s.viewN .. " lastKey=" .. s.lastKey .. " ev=" .. s.lastEv, "muted") }) })
		local main
		local layer = nil
		if s.mode == "input" then
			main = ui.col({
				ui.text({ ui.span("jcount=" .. s.jcount .. " submitted=[" .. s.submitted .. "] cancelled=" .. s.cancelled .. " field=" .. s.field, "warn") }),
				ui.node("input", { key = "inp", text = s.inp, cursor = s.inpCur, placeholder = "single line (Enter submits, Esc cancels)", prompt = { ui.span("> ", "muted") } }),
				ui.node("editor", { key = "ed", text = s.ed, cursor = s.edCur, placeholder = "multi line (Shift+Enter newline)", maxLines = 5, prompt = { ui.span("> ", "muted") } }),
				ui.text({ ui.span("inp=[" .. s.inp .. "] ed=[" .. string.gsub(s.ed, "\n", "\\n") .. "]", "muted") }),
			})
		elseif s.mode == "diff" then
			local d = ui.diff(PATCH, "compose.ts")
			local p = d.p or {}
			p.actions = { click = "diffclick" }
			p.mode = "unified"
			p.key = "diff"
			d.p = p
			main = ui.col({ ui.card({ ui.span("compose.ts", "strong") }, { d }), ui.text({ ui.span("click a diff line; event shown in dock", "muted") }) })
		elseif s.mode == "diff2" then
			-- one diff node per diff line so a click names the line; thread cards sit between nodes
			local kids = {}
			local oldn, newn = 1, 1
			local rows = { " import { herdr } from './herdr';", "-const backend = herdr();", "+export function pickBackend(env: Env) {", "+  return env.terminal;", "+}", " export const x = 1;", " export const y = 2;" }
			for i, l in rows do
				local c = string.sub(l, 1, 1)
				local d = ui.node("diff", { key = "d" .. i, mode = "unified", path = "compose.ts", hunks = { { oldStart = oldn, newStart = newn, lines = { l } } }, actions = { click = "dl=" .. i } })
				kids[#kids + 1] = d
				if c ~= "+" then oldn += 1 end
				if c ~= "-" then newn += 1 end
				if s.open[i] then
					kids[#kids + 1] = ui.card({ ui.span("thread on line " .. i, "strong") }, { ui.text({ ui.span("copilot: is this typed?", "") }), ui.node("input", { key = "ti" .. i, placeholder = "reply" }) })
				end
			end
			main = ui.col({ ui.col(kids) })
		elseif s.mode == "rows" then
			local kids = {}
			for _, l in s.lines do
				local rail = {}
				if l.n % 20 == 3 then
					rail[1] = ui.el("div", { class = "tp-card", text = "thread @" .. l.n .. ": is this typed?" })
				end
				kids[#kids + 1] = ui.el("div", { class = "tp-row tp-" .. l.kind, key = "r" .. l.n }, {
					ui.el("span", { class = "tp-gut", text = tostring(l.n) }),
					ui.el("span", { class = "tp-plus", text = "+", actions = { click = "cmt=" .. l.n } }),
					ui.el("span", { class = "tp-code", text = l.code, actions = { click = "line=" .. l.n } }),
					ui.el("div", { class = "tp-rail" }, rail),
				})
				if s.open[l.n] then
					kids[#kids + 1] = ui.el("div", { class = "tp-thread", key = "t" .. l.n }, {
						ui.el("div", { text = "you: new thread on line " .. l.n }),
					})
				end
			end
			main = ui.el("div", { key = "list" }, kids)
			main = ui.col({ main })
		elseif s.mode == "md" then
			local m = ui.md(MD)
			local mp = m.p or {}
			mp.actions = { click = "mdclick" }
			m.p = mp
			local per = {}
			for i, para in mdParas() do
				local n = ui.md(para)
				local np = n.p or {}
				np.actions = { click = "para=" .. i }
				np.key = "p" .. i
				n.p = np
				per[#per + 1] = n
			end
			main = ui.col({ ui.rule("single md node, click -> action"), m, ui.rule("split per block"), ui.col(per) })
		elseif s.mode == "layer" then
			main = ui.col({ ui.text({ ui.span("coordinator area (press o for overlay, Esc closes)", "muted") }), btn("open overlay", "overlay=open", "accent") })
			if s.overlay then
				layer = ui.col({ ui.node("overlay", { head = { ui.span("Approve brief: Terminal backend", "strong") }, anchor = "center", size = "md", modal = false }, {
					ui.text({ ui.span("Plan: extract port, migrate callers. Esc to dismiss.", "") }),
					btn("Approve", "approve", "success"), btn("Close", "overlay=close", "muted") }) })
			end
		elseif s.mode == "motion" then
			main = ui.col({
				ui.row({ ui.node("spinner", { style = "dots", label = "task A" }), ui.node("elapsed", { age = 0 }) }),
				ui.row({ ui.node("spinner", { style = "braille", label = "task B" }), ui.node("elapsed", { age = 5000 }) }),
				ui.row({ ui.node("spinner", { style = "orbit", label = "task C" }), ui.node("elapsed", { age = 60000, format = "clock" }) }),
			})
		else
			main = ui.col({
				ui.text({ ui.span("clicks=" .. s.linkClicks, "warn") }),
				btn("PR #281 (action -> cx:open)", "openpr", "accent"),
				ui.node("text", { spans = { ui.link("PR #281 span link (cmd-click)", PR) } }),
				ui.node("text", { href = PR, actions = { click = "open" }, spans = { ui.span("PR #281 node href + open action", "accent") } }),
			})
		end
		s.lastViewMs = (os.clock() - t0) * 1000
		if s.mode == "rows" then log("rows view build ms=" .. s.lastViewMs .. " nodes~" .. (#s.lines * 6)) end
		return { main = main, dock = dock, layer = layer }
	end,
	key = function(s, key, cx)
		s.lastKey = key.name .. (if key.text then "/" .. key.text else "")
		log("key " .. s.lastKey .. " mode=" .. s.mode)
		if s.mode == "layer" then
			if key.name == "escape" then s.overlay = false elseif key.name == "o" then s.overlay = true else return false end
			return true
		end
		if s.mode ~= "input" then
			if key.name == "j" then s.jcount += 1 return true end
			return false
		end
		local fld = s.field
		local txt = if fld == "inp" then s.inp else s.ed
		local cur = if fld == "inp" then s.inpCur else s.edCur
		if key.name == "tab" then
			s.field = if fld == "inp" then "ed" else "inp"
			cx:frame({ { "focus", "main." .. s.field } })
			return true
		elseif key.name == "escape" then
			s.cancelled += 1
			if fld == "inp" then s.inp, s.inpCur = "", 0 else s.ed, s.edCur = "", 0 end
			return true
		elseif key.name == "enter" and (fld == "inp" or not key.shift) then
			s.submitted = txt
			if fld == "inp" then s.inp, s.inpCur = "", 0 else s.ed, s.edCur = "", 0 end
			return true
		elseif key.name == "enter" then
			txt = txt:sub(1, cur) .. "\n" .. txt:sub(cur + 1) cur += 1
		elseif key.name == "backspace" then
			if cur > 0 then txt = txt:sub(1, cur - 1) .. txt:sub(cur + 1) cur -= 1 end
		elseif key.text and not (key.ctrl or key.meta) then
			txt = txt:sub(1, cur) .. key.text .. txt:sub(cur + 1) cur += #key.text
		else
			return false
		end
		if fld == "inp" then s.inp, s.inpCur = txt, cur else s.ed, s.edCur = txt, cur end
		return true
	end,
	event = function(s, ev, cx)
		s.lastEv = tern.json.encode(ev)
		log("event " .. s.lastEv)
		if ev.ev == "focus" then
			cx:frame({ { "focus", ev.id } })
			s.field = if string.find(ev.id, "ed$") then "ed" else "inp"
			return
		end
		if ev.ev ~= "action" then return end
		if ev.act == "mode" then
			s.mode = ev.value
			if s.mode == "input" then cx:frame({ { "focus", "main." .. s.field } }) end
		elseif ev.act == "dl" then
			local n = tonumber(ev.value)
			s.open[n] = not s.open[n]
		elseif ev.act == "cmt" then
			local n = tonumber(ev.value)
			s.open[n] = not s.open[n]
		elseif ev.act == "overlay" then
			s.overlay = ev.value == "open"
		elseif ev.act == "openpr" then
			s.linkClicks += 1
			cx:open(PR)
		end
	end,
	save = function(s) return {} end,
}

tern.block.define("lab", lab)
