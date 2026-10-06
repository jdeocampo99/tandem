--!strict
local ui = tern.ui
local views = require('./view-file')
local fields = require('./text-field')
local components = require('./components')

type Event = { seq: number, at: string, type: string, cause: string?, from: string?, to: string?, stage: string?, round: number? }
type Model = {
 header: { id: string, title: string, stage: string, elapsed: string, returnLabel: string, model: string?, branch: string? },
 rightNow: { text: string, age: string? },
 stageTrack: { { label: string, state: string, round: { used: number, max: number }? } }, tabs: { string },
 overview: { summary: string, todos: { { content: string, status: string } }, done: number, total: number, recent: { Event } },
 progress: { events: { Event }, unreadableEvents: number, checks: { { name: string, passed: boolean, head: string, contract: string } },
  findings: { { id: string, severity: string, description: string, file: string?, line: number?, status: string } } },
 stuck: { reason: string }?, requestId: string?, pullRequest: { number: number }?,
 message: { placeholder: string, model: string? },
 cost: { recorded: boolean, charges: { amountMicros: number, unavailableSamples: number },
  tokens: { actualInputTokens: number, actualOutputTokens: number, estimatedInputTokens: number, estimatedOutputTokens: number, unavailableSamples: number },
  timing: { elapsedMs: number | string, activeMs: number, waitingMs: number | string },
  quota: { entries: { { plan: string, units: number, unit: string } }, unavailableSamples: number },
  breakdown: { byProvider: { { provider: string, model: string, charges: { amountMicros: number, unavailableSamples: number },
   tokens: { actualInputTokens: number, actualOutputTokens: number, estimatedInputTokens: number, estimatedOutputTokens: number } } },
   byWorkKind: { { workKind: string, activeMs: number } }, malformedSamples: number, omittedSamples: number } }?,
}
type State = { view: views.View<Model>, field: fields.Field, tab: string, cwd: string, orchestrator: string?, busy: boolean, editing: boolean }

local function parse(value: unknown): Model?
 if type(value) ~= 'table' or type(value.header) ~= 'table' or type(value.header.id) ~= 'string'
  or not string.match(value.header.id, '^[%w_-]+$') or type(value.header.title) ~= 'string'
  or type(value.header.returnLabel) ~= 'string' or type(value.header.elapsed) ~= 'string'
  or type(value.rightNow) ~= 'table' or type(value.rightNow.text) ~= 'string'
  or type(value.stageTrack) ~= 'table' or type(value.tabs) ~= 'table'
  or type(value.overview) ~= 'table' or type(value.overview.summary) ~= 'string'
  or type(value.overview.todos) ~= 'table' or type(value.overview.recent) ~= 'table'
  or type(value.progress) ~= 'table' or type(value.progress.events) ~= 'table'
  or type(value.progress.checks) ~= 'table' or type(value.progress.findings) ~= 'table'
  or type(value.message) ~= 'table' or type(value.message.placeholder) ~= 'string' then return nil end
 for _, step in value.stageTrack do
  if type(step) ~= 'table' or type(step.label) ~= 'string' or type(step.state) ~= 'string' then return nil end
 end
 for _, tab in value.tabs do if type(tab) ~= 'string' then return nil end end
 for _, todo in value.overview.todos do
  if type(todo) ~= 'table' or type(todo.content) ~= 'string' or type(todo.status) ~= 'string' then return nil end
 end
 if value.stuck ~= nil and (type(value.stuck) ~= 'table' or type(value.stuck.reason) ~= 'string') then return nil end
 return value :: Model
end

local function text(value: string, tone: string?): Node return components.text(value, tone) end
local function button(label: string, action: string, primary: boolean?): Node
 return ui.el('button', { text = label, class = if primary then 'tt-button tt-primary' else 'tt-button', actions = { click = action } })
end
local function section(title: string, nodes: { Node }): Node
 return ui.el('section', { class = 'tt-section' }, { ui.el('h3', { text = title }), ui.col(nodes) })
end
local function eventNode(event: Event): Node
 local label = string.gsub(event.type, '-', ' ')
 if event.type == 'stage-changed' then label = (event.from or '') .. ' → ' .. (event.to or '')
 elseif event.type == 'fix-round' then label = 'Fix round ' .. tostring(event.round)
 elseif event.type == 'created' then label = 'Started · ' .. (event.stage or '') end
 return ui.el('div', { key = 'event-' .. event.seq, class = 'tt-event' }, {
  text(string.sub(event.at, 12, 16), 'muted'), text(label), text(event.cause or '', 'muted'),
 })
end
local function duration(ms: number | string): string
 return if type(ms) == 'number' then string.format('%.1fm', ms / 60000) else ms
end
local function costNode(model: Model): Node
 local cost = model.cost
 if not cost or not cost.recorded then return text('Usage receipt unavailable. No recorded task usage yet.', 'muted') end
 local rows = { text(string.format('Additional charges · $%.2f', cost.charges.amountMicros / 1000000), 'strong') }
 for _, provider in cost.breakdown.byProvider do
  table.insert(rows, text(string.format('%s / %s · %d in · %d out · $%.2f', provider.provider, provider.model,
   provider.tokens.actualInputTokens + provider.tokens.estimatedInputTokens,
   provider.tokens.actualOutputTokens + provider.tokens.estimatedOutputTokens, provider.charges.amountMicros / 1000000)))
 end
 table.insert(rows, text(string.format('Tokens · %d actual input / %d actual output · %d estimated input / %d estimated output',
  cost.tokens.actualInputTokens, cost.tokens.actualOutputTokens, cost.tokens.estimatedInputTokens, cost.tokens.estimatedOutputTokens), 'muted'))
 table.insert(rows, text(string.format('Unpriced samples: %d · Unmeasured token samples: %d', cost.charges.unavailableSamples, cost.tokens.unavailableSamples), 'muted'))
 for _, quota in cost.quota.entries do table.insert(rows, text(string.format('Included quota · %s · %g %s', quota.plan, quota.units, quota.unit))) end
 table.insert(rows, text('Unavailable quota samples: ' .. cost.quota.unavailableSamples, 'muted'))
 table.insert(rows, text('Elapsed ' .. duration(cost.timing.elapsedMs) .. ' · Active ' .. duration(cost.timing.activeMs) .. ' · Waiting ' .. duration(cost.timing.waitingMs)))
 for _, stage in cost.breakdown.byWorkKind do table.insert(rows, text(stage.workKind .. ' · ' .. duration(stage.activeMs), 'muted')) end
 table.insert(rows, text(string.format('Unreadable samples: %d · Omitted samples: %d', cost.breakdown.malformedSamples, cost.breakdown.omittedSamples), 'muted'))
 return section('Usage receipt', rows)
end
local function body(state: State, model: Model): Node
 if state.tab == 'Overview' then
  local todos, events = {}, {}
  for i, todo in model.overview.todos do
   local doing = todo.status == 'in_progress'
   table.insert(todos, ui.el('div', { key = 'todo-' .. i, class = if doing then 'tt-todo tt-doing' else 'tt-todo' }, {
    text(if todo.status == 'completed' then '✓' else '○', if doing then 'accent' else 'muted'), text(todo.content),
    text(if doing then 'doing' else '', 'accent'),
   }))
  end
  if #todos == 0 then table.insert(todos, text('No worker to-dos yet.', 'muted')) end
  for _, event in model.overview.recent do table.insert(events, eventNode(event)) end
  if #events == 0 then table.insert(events, text('No saved events yet.', 'muted')) end
  return ui.col({ section('Summary', { ui.md(model.overview.summary) }),
   section(string.format('To-dos · %d of %d', model.overview.done, model.overview.total), todos), section('Recent events', events) })
 elseif state.tab == 'Progress' then
  local events, checks, findings = {}, {}, {}
  for _, event in model.progress.events do table.insert(events, eventNode(event)) end
  if model.progress.unreadableEvents > 0 then table.insert(events, text(tostring(model.progress.unreadableEvents) .. ' unreadable events', 'warn')) end
  for _, check in model.progress.checks do table.insert(checks, text((if check.passed then '✓ PASS · ' else '✕ FAIL · ') .. check.name .. ' · ' .. check.contract .. ' · ' .. check.head, if check.passed then 'success' else 'danger')) end
  for _, finding in model.progress.findings do
   table.insert(findings, ui.el('div', { key = 'finding-' .. finding.id, class = 'tt-finding' }, {
    text(finding.severity .. ' · ' .. finding.status, 'strong'),
    text((finding.file or '') .. (if finding.line then ':' .. finding.line else ''), 'muted'), ui.md(finding.description),
   }))
  end
  return ui.col({ section('Timeline', events), section('Validation checks', if #checks > 0 then checks else { text('No validation evidence yet.', 'muted') }),
   section('Review findings', if #findings > 0 then findings else { text('No saved findings.', 'muted') }) })
 elseif state.tab == 'Brief' then
  return ui.col({ text('The request brief is available beside the conversation.'), button('Open brief', 'open-brief') })
 elseif state.tab == 'Diff' or state.tab == 'PR' then
  return ui.col({ text(if model.pullRequest then 'Open the PR pane to read the description, diff and review threads.' else 'No pull request is available yet.', 'muted'),
   if model.pullRequest then button('Open PR #' .. model.pullRequest.number, 'open-pr') else text('The branch is ' .. (model.header.branch or 'unavailable'), 'muted') })
 elseif state.tab == 'Cost' then return costNode(model) end
 return text('Choose a tab.', 'muted')
end

local function run(state: State, cx: BlockCx, args: { string }, clear: boolean?)
 if state.busy or state.view.status ~= 'ready' then return end
 if string.sub(state.cwd, 1, 1) ~= '/' then cx:toast('error', 'Tandem action unavailable', 'An absolute originating cwd is required.'); return end
 local argv = { '/bin/sh', 'tandem.sh', 'native' }
 for _, arg in args do table.insert(argv, arg) end
 table.insert(argv, '--pane'); table.insert(argv, string.format('%.0f', cx.pane))
 table.insert(argv, '--cwd'); table.insert(argv, state.cwd)
 local window = tern.getenv('TERN_WINDOW_KEY')
 if window and window ~= '' then table.insert(argv, '--window'); table.insert(argv, window) end
 state.busy = true; cx:render()
 local ok, problem = pcall(function()
  tern.process.run(argv, { cwd = '.' }, function(result, callbackCx)
   state.busy = false
   if result.status == 0 and clear then state.field = fields.create('', true) end
   if callbackCx then
    if result.status ~= 0 then callbackCx:toast('error', 'Tandem action failed', result.stderr) end
    callbackCx:render()
   end
  end)
 end)
 if not ok then state.busy = false; cx:toast('error', 'Tandem action could not start', tostring(problem)); cx:render() end
end
local function send(state: State, cx: BlockCx)
 local model = state.view.model
 if model and string.match(state.field.text, '%S') then run(state, cx, { 'steer', '--task', model.header.id, '--text', state.field.text }, true) end
end
local block: BlockDef<State> = {
 init = function(cx, args)
  local state = { view = views.create(args[1] or '', 'task', parse), field = fields.create('', true), tab = 'Overview', cwd = args[2] or '', orchestrator = args[3], busy = false, editing = false }
  views.refresh(state.view); views.watch(state.view, cx)
  return state
 end,
 title = function(state) return if state.view.model then state.view.model.header.title else 'Task' end,
 view = function(state)
  local model = state.view.model
  if not model then return text('Task view unavailable. Waiting for its saved detail file.', 'warn') end
  local track, tabs = {}, {}
  for i, step in model.stageTrack do
   if i > 1 then table.insert(track, text('→', 'muted')) end
   local label = (if step.state == 'done' then '✓ ' else '') .. step.label
   if step.round then label ..= string.format(' · round %d of %d', step.round.used, step.round.max) end
   if step.state == 'skipped' then label ..= ' (skipped)' end
   table.insert(track, text(label, if step.state == 'current' then 'accent' elseif step.state == 'done' then 'success' else 'muted'))
  end
  for _, tab in model.tabs do table.insert(tabs, button(tab, 'tab=' .. tab, tab == state.tab)) end
  local header = ui.el('div', { class = 'tt-header' }, {
   ui.el('div', { class = 'tt-title-row' }, { ui.el('h1', { text = model.header.title }), text('task #' .. model.header.id, 'muted'), button(model.header.returnLabel, 'orchestrator') }),
   ui.row({ text(model.header.model or 'Model unavailable', 'accent'), text(model.header.elapsed .. ' elapsed', 'muted'), text(model.header.branch or 'Branch unavailable', 'muted') }),
   ui.el('div', { class = 'tt-glance' }, {
    ui.el('div', { class = 'tt-glance-card' }, { text('Right now', 'muted'), text('▸ ' .. model.rightNow.text .. (if model.rightNow.age then ' · ' .. model.rightNow.age .. ' ago' else '')) }),
    ui.el('div', { class = 'tt-glance-card' }, { text('Agent progress', 'muted'), ui.row(track) }),
   }), ui.el('div', { class = 'tt-tabs' }, tabs),
  })
  local children = { header }
  if state.view.status ~= 'ready' then table.insert(children, text('Saved view unavailable. Actions are disabled until fresh data arrives.', 'warn')) end
  if model.stuck then table.insert(children, ui.el('div', { class = 'tt-stuck' }, {
   ui.col({ text('Stuck', 'warn'), text(model.stuck.reason, 'strong') }), button('Restart', 'restart', true), button('Steer…', 'steer'),
  })) end
  table.insert(children, ui.el('div', { class = 'tt-body' }, { body(state, model) }))
  table.insert(children, ui.el('div', { class = 'tt-message', actions = { click = 'focus-message' } }, {
   fields.node(state.field, 'worker-message', model.message.placeholder),
   ui.row({ text(model.message.model or model.header.model or 'Model unavailable', 'accent'), text('Steers the worker; it reads this at its next safe step', 'muted'),
    button(if state.busy then 'Sending…' else 'Send ↑', 'send', true) }),
  }))
  return ui.el('div', { class = 'tt-page' }, children)
 end,
 on_action = function(state, cx, action)
  local tab = string.match(action, '^tab=(.+)$')
  if tab and state.view.model and table.find(state.view.model.tabs, tab) then state.tab = tab; state.editing = false; cx:render(); return end
  if action == 'focus-message' or action == 'steer' then state.editing = true; cx:render(); return end
  if action == 'send' then send(state, cx); return end
  local model = state.view.model
  if not model then return end
  if action == 'restart' and model.stuck then run(state, cx, { 'restart', model.header.id })
  elseif action == 'open-brief' and model.requestId then run(state, cx, { 'open', 'brief', model.requestId })
  elseif action == 'open-pr' and model.pullRequest then run(state, cx, { 'open', 'pr', tostring(model.pullRequest.number) })
  end
 end,
 on_key = function(state, cx, key)
  if not state.editing then return false end
  local outcome = fields.key(state.field, key)
  if outcome == 'submit' then send(state, cx)
  elseif outcome == 'cancel' or outcome == 'next' then state.editing = false; cx:render()
  elseif outcome == 'changed' then cx:render() end
  return outcome ~= 'ignored'
 end,
}
return block
