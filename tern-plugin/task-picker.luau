--!strict
local ui = tern.ui
local views = require('./view-file')
local fields = require('./text-field')
local navigation = require('./navigation')
local components = require('./components')
type Task = { taskId: string, title: string, stage: string, model: string? }
type Model = { project: string, tasks: { [string]: Task } }
type State = { origin: navigation.Origin, view: views.View<Model>, field: fields.Field, cwd: string, busy: boolean, selected: number }
local function parse(value: unknown): Model?
 if type(value) ~= 'table' or type(value.project) ~= 'string' or type(value.tasks) ~= 'table' then return nil end
 for id, task in value.tasks do
  if type(id) ~= 'string' or type(task) ~= 'table' or task.taskId ~= id or not string.match(id, '^[%w_-]+$')
   or type(task.title) ~= 'string' or type(task.stage) ~= 'string' or (task.model ~= nil and type(task.model) ~= 'string') then return nil end
 end
 return value :: Model
end
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
 if state.busy or state.view.status ~= 'ready' or not state.view.model or not state.view.model.tasks[id] then return end
 if string.sub(state.cwd, 1, 1) ~= '/' then cx:toast('error', 'Task picker unavailable', 'An absolute originating cwd is required.'); return end
 local argv = { '/bin/sh', 'tandem.sh', 'native', 'open', 'task', id, '--pane', string.format('%.0f', cx.pane), '--cwd', state.cwd }
 if state.origin.home ~= '' then table.insert(argv, '--home'); table.insert(argv, state.origin.home) end
 local window = state.origin.window
 if window and window ~= '' then table.insert(argv, '--window'); table.insert(argv, window) end
 state.busy = true
 local ok, problem = pcall(function()
  tern.process.run(argv, { cwd = '.' }, function(result)
   state.busy = false
   if result.status ~= 0 then cx:toast('error', 'Task could not open', result.stderr); cx:render() else cx:exit(0) end
  end)
 end)
 if not ok then state.busy = false; cx:toast('error', 'Task could not open', tostring(problem)) end
end
local block: BlockDef<State> = {
 init = function(cx, args)
  local origin = navigation.origin(args)
  local state = { origin = origin, view = views.create(args[1] or '', 'panel', parse), field = fields.create(), cwd = origin.cwd, busy = false, selected = 1 }
  views.refresh(state.view); views.watch(state.view, cx)
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
  if event.ev == 'action' and event.act == 'cancel' then navigation.back(state.origin, cx); return end
  if event.ev == 'action' and event.act == 'open' and event.value then open(state, cx, event.value) end
 end,
 key = function(state, key, cx)
  if key.name == 'up' or key.name == 'down' then state.selected = math.clamp(state.selected + (if key.name == 'up' then -1 else 1), 1, math.max(1, #choices(state))); cx:render(); return true end
  local outcome = fields.key(state.field, key)
  if outcome == 'submit' then local first = choices(state)[state.selected]; if first then open(state, cx, first.taskId) end
  elseif outcome == 'changed' then state.selected = 1; cx:render()
  elseif outcome == 'cancel' then navigation.back(state.origin, cx) end
  return outcome ~= 'ignored'
 end,
}
return block
