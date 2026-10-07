--!strict
-- The quick task composer: one text field, the project it starts in, and Start. Start is the
-- user's approval of exactly what they typed; `tandem native act` checks the text again and
-- records it.
local ui = tern.ui
local fields = require("./text-field")
local components = require("./components")
local rt = require("./rt")

-- `QuickTaskView` in src/tasks/quick.ts.
type Model = {
 repo: string, branch: string, placeholder: string, minChars: number, minWords: number, maxChars: number,
 tooShort: string, tooLong: string,
}
type State = { file: rt.Watch, origin: rt.Origin, field: fields.Field, started: boolean }

local function trimmed(text: string): string
 return (string.gsub(string.gsub(text, "^%s+", ""), "%s+$", ""))
end

local function words(text: string): number
 local count = 0
 for _ in string.gmatch(text, "%S+") do count += 1 end
 return count
end

-- The same length and word checks `tandem native act` applies, so Start is disabled for text it
-- would refuse. Returns why Start is refused, or nil when the text describes a change.
local function problem(state: State): string?
 local model = state.file.model :: Model?
 if state.file.status ~= "ready" or not model then return "Describe the change in a sentence or two." end
 local text = trimmed(state.field.text)
 local length = utf8.len(text) or #text
 if length < model.minChars or words(text) < model.minWords then return model.tooShort end
 if length > model.maxChars then return model.tooLong end
 return nil
end

local function describes(state: State): boolean
 return problem(state) == nil
end

local function start(state: State, cx: BlockCx)
 if state.origin.busy or state.started then return end
 local refused = problem(state)
 if refused then
  cx:toast("warning", "Quick task", refused)
  return
 end
 if state.origin.ctx == "" then
  cx:toast("error", "Missing Tandem context", "Open the quick task composer again from the palette.")
  return
 end
 rt.act(cx, state.origin, { verb = "quick-start", text = state.field.text }, function(outcome)
  if outcome == nil or outcome.status == "refused" then
   pcall(function() cx:render() end)
   return
  end
  state.started = true
  cx:exit(0)
 end, rt.QUICK)
end

local block: BlockDef<State> = {
 init = function(cx, args)
  local state: State = {
   file = rt.watch(cx, args[1] or "", "quick-task"), origin = rt.origin(args),
   field = fields.create(nil, true), started = false,
  }
  -- The block is listed only after init returns, so focus moves in a timer.
  tern.timer(1, function()
   pcall(function() cx:frame({ { "focus", "main.quick-text" } }) end)
  end)
  return state
 end,
 title = function() return "Quick task" end,
 view = function(state)
  local model = state.file.model :: Model?
  local children: { Node } = {
   ui.el("div", { class = "quick-header" }, {
    components.text("Quick task", "strong"), components.button("×", "close"),
   }),
   components.text("Small, well-defined changes. No interview.", "muted"),
   fields.node(state.field, "quick-text", if model then model.placeholder else "Describe the change"),
   ui.el("div", { class = "quick-chip", key = "chip" }, {
    components.text(if model then model.repo .. " · " .. model.branch else "Waiting for this project…", "muted"),
   }),
  }
  if state.file.status ~= "ready" then
   table.insert(children, components.text("Quick task unavailable. Start is disabled until this project's view returns.", "warn"))
  end
  local actions: { Node } = {}
  if state.origin.busy then
   table.insert(actions, components.text("Starting…", "muted"))
  elseif describes(state) then
   table.insert(actions, components.button("Start  ⌘↵", "start", "accent"))
  else
   table.insert(actions, components.text("Start  ⌘↵", "muted"))
  end
  return {
   main = ui.col({ ui.el("div", { class = "quick-composer" }, children) }),
   dock = ui.col({ ui.el("div", { class = "quick-bottom" }, actions) }),
  }
 end,
 key = function(state, key, cx)
  if state.origin.busy or state.started then return false end
  if key.name == "enter" and key.meta then start(state, cx); return true end
  local outcome = fields.key(state.field, key)
  if outcome == "cancel" then cx:exit(0); return true end
  if outcome == "submit" then
   -- Plain Enter is a new line; only ⌘↵ starts.
   local newline = table.clone(key)
   newline.shift = true
   fields.key(state.field, newline)
   return true
  end
  return outcome ~= "ignored"
 end,
 event = function(state, ev, cx)
  if ev.ev == "focus" then
   pcall(function() cx:frame({ { "focus", ev.id } }) end)
   return
  end
  if ev.ev ~= "action" then return end
  if ev.act == "close" then cx:exit(0)
  elseif ev.act == "start" then start(state, cx) end
 end,
 -- The typed text is transient; nothing is saved until Start.
 save = function() return {} end,
}
return block
