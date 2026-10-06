--!strict
local ui = tern.ui
local fields = require('./text-field')
local rt = require('./rt')
local components = require('./components')
type Task = { taskId: string, title: string, stage: string, model: string? }
type State = { origin: rt.Origin, view: rt.Watch, field: fields.Field, selected: number }
local function choices(state: State): { Task }
 local rows = {}
 if not state.view.model then return rows end
 local query = string.lower(state.field.text)
 for _, task in state.view.model.tasks do
  local haystack = string.lower(task.taskId .. ' ' .. task.title .. ' ' .. task.stage)
  if string.find(haystack, query, 1, true) then table.insert(rows, task) end
 end
 table.sort(rows, function(a, b) return a.title < b.title end)
 return rows
end
local function open(state: State, cx: BlockCx, id: string)
 if state.view.status ~= 'ready' or not state.view.model or not state.view.model.tasks[id] then return end
 rt.act(cx, state.origin, { verb = 'open', ref = { kind = 'task', taskId = id } }, function(outcome)
  if outcome and outcome.status == 'done' then cx:exit(0) else cx:render() end
 end, rt.PICKER)
end
local function back(state: State, cx: BlockCx)
 rt.act(cx, state.origin, { verb = 'open', ref = { kind = 'orchestrator' } })
end
local block: BlockDef<State> = {
 init = function(cx, args)
  local state = { origin = rt.origin(args), view = rt.watch(cx, args[1] or '', 'index'), field = fields.create(), selected = 1 }
  return state
 end,
 title = function() return 'Open task…' end,
 view = function(state)
  local rows = { ui.row({ui.el('h1', { text = 'Open task…' }), components.button('Cancel', 'cancel')}), fields.node(state.field, 'task-search', 'Search tasks by title, id or stage') }
  if state.view.status ~= 'ready' then table.insert(rows, components.text('Task list unavailable. Wait for fresh saved project data.', 'warn')) end
  for index, task in choices(state) do
   table.insert(rows, ui.el('button', { key = 'task-' .. task.taskId, class = if index == state.selected then 'tt-picker-row tt-picker-selected' else 'tt-picker-row', actions = { click = 'open=' .. task.taskId } }, {
    components.text(task.title, 'strong'), components.text('task #' .. task.taskId .. ' · ' .. task.stage .. (if task.model then ' · ' .. task.model else ''), 'muted'),
   }))
  end
  if #choices(state) == 0 then table.insert(rows, components.text('No matching tasks.', 'muted')) end
  return { main = ui.el('div', { class = 'tt-picker' }, rows) }
 end,
 event = function(state, event, cx)
  if event.ev == 'focus' then return end
  if event.ev == 'action' and event.act == 'cancel' then back(state, cx); return end
  if event.ev == 'action' and event.act == 'open' and event.value then open(state, cx, event.value) end
 end,
 key = function(state, key, cx)
  if key.name == 'up' or key.name == 'down' then state.selected = math.clamp(state.selected + (if key.name == 'up' then -1 else 1), 1, math.max(1, #choices(state))); cx:render(); return true end
  local outcome = fields.key(state.field, key)
  if outcome == 'submit' then local first = choices(state)[state.selected]; if first then open(state, cx, first.taskId) end
  elseif outcome == 'changed' then state.selected = 1; cx:render()
  elseif outcome == 'cancel' then back(state, cx) end
  return outcome ~= 'ignored'
 end,
}
return block
