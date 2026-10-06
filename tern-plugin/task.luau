--!strict
local ui = tern.ui
local views = require('./view-file')
local fields = require('./text-field')
local components = require('./components')
local rt = require('./rt')
local prModels = require('./pr-model')
local prContent = require('./pr-content')

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
   tokens: { actualInputTokens: number, actualOutputTokens: number, estimatedInputTokens: number, estimatedOutputTokens: number, unavailableSamples: number } } },
   byWorkKind: { { workKind: string, activeMs: number } }, malformedSamples: number, omittedSamples: number } }?,
}
type Index = prModels.Index & { briefs: { [string]: { detailFile: string } } }
type Brief = { title: string, revision: number, lines: { { id: string, number: number, text: string, kind: string, isNew: boolean } } }
type State = { origin: rt.Origin, index: views.View<Index>?, brief: views.View<Brief>?, pr: views.View<prModels.Model>?, prContent: prContent.State, stopBrief: (() -> ())?, stopPr: (() -> ())?, view: views.View<Model>, field: fields.Field, tab: string, prMatch: boolean, editing: boolean }

local function optionalString(value: unknown): boolean return value == nil or type(value) == 'string' end
local function events(value: unknown): boolean
 if type(value) ~= 'table' then return false end
 for _, event in value do
  if type(event) ~= 'table' or type(event.seq) ~= 'number' or type(event.at) ~= 'string' or type(event.type) ~= 'string'
   or not optionalString(event.cause) or not optionalString(event.from) or not optionalString(event.to) or not optionalString(event.stage)
   or (event.round ~= nil and type(event.round) ~= 'number') then return false end
 end
 return true
end
local function numbers(value: unknown, keys: { string }): boolean
 if type(value) ~= 'table' then return false end
 for _, key in keys do if type(value[key]) ~= 'number' then return false end end
 return true
end
local function parse(value: unknown): Model?
 if type(value) ~= 'table' or type(value.header) ~= 'table' or type(value.header.id) ~= 'string'
  or not string.match(value.header.id, '^[%w_-]+$') or type(value.header.title) ~= 'string'
  or type(value.header.stage) ~= 'string' or type(value.header.returnLabel) ~= 'string' or type(value.header.elapsed) ~= 'string'
  or not optionalString(value.header.model) or not optionalString(value.header.branch)
  or type(value.rightNow) ~= 'table' or type(value.rightNow.text) ~= 'string' or not optionalString(value.rightNow.age)
  or type(value.stageTrack) ~= 'table' or type(value.tabs) ~= 'table'
  or type(value.overview) ~= 'table' or type(value.overview.summary) ~= 'string'
  or not numbers(value.overview, { 'done', 'total' }) or type(value.overview.todos) ~= 'table' or not events(value.overview.recent)
  or type(value.progress) ~= 'table' or not events(value.progress.events) or type(value.progress.unreadableEvents) ~= 'number'
  or type(value.progress.checks) ~= 'table' or type(value.progress.findings) ~= 'table'
  or type(value.message) ~= 'table' or type(value.message.placeholder) ~= 'string' or not optionalString(value.message.model)
  or not optionalString(value.requestId) then return nil end
 for _, step in value.stageTrack do
  if type(step) ~= 'table' or type(step.label) ~= 'string' or not table.find({ 'done', 'current', 'pending', 'skipped' }, step.state)
   or (step.round ~= nil and not numbers(step.round, { 'used', 'max' })) then return nil end
 end
 for _, tab in value.tabs do if type(tab) ~= 'string' then return nil end end
 for _, todo in value.overview.todos do
  if type(todo) ~= 'table' or type(todo.content) ~= 'string' or type(todo.status) ~= 'string' then return nil end
 end
 for _, check in value.progress.checks do
  if type(check) ~= 'table' or type(check.name) ~= 'string' or type(check.passed) ~= 'boolean'
   or type(check.head) ~= 'string' or type(check.contract) ~= 'string' then return nil end
 end
 for _, finding in value.progress.findings do
  if type(finding) ~= 'table' or type(finding.id) ~= 'string' or type(finding.severity) ~= 'string'
   or type(finding.description) ~= 'string' or type(finding.status) ~= 'string' or not optionalString(finding.file)
   or (finding.line ~= nil and type(finding.line) ~= 'number') then return nil end
 end
 if value.stuck ~= nil and (type(value.stuck) ~= 'table' or type(value.stuck.reason) ~= 'string') then return nil end
 if value.pullRequest ~= nil and (type(value.pullRequest) ~= 'table' or type(value.pullRequest.number) ~= 'number') then return nil end
 local cost = value.cost
 if cost ~= nil then
  if type(cost) ~= 'table' or type(cost.recorded) ~= 'boolean' or not numbers(cost.charges, { 'amountMicros', 'unavailableSamples' })
   or not numbers(cost.tokens, { 'actualInputTokens', 'actualOutputTokens', 'estimatedInputTokens', 'estimatedOutputTokens', 'unavailableSamples' })
   or type(cost.timing) ~= 'table' or type(cost.timing.activeMs) ~= 'number'
   or (type(cost.timing.elapsedMs) ~= 'number' and cost.timing.elapsedMs ~= 'unavailable')
   or (type(cost.timing.waitingMs) ~= 'number' and cost.timing.waitingMs ~= 'unavailable')
   or type(cost.quota) ~= 'table' or type(cost.quota.entries) ~= 'table' or type(cost.quota.unavailableSamples) ~= 'number'
   or not numbers(cost.breakdown, { 'malformedSamples', 'omittedSamples' }) or type(cost.breakdown.byProvider) ~= 'table'
   or type(cost.breakdown.byWorkKind) ~= 'table' then return nil end
  for _, row in cost.breakdown.byProvider do
   if type(row) ~= 'table' or type(row.provider) ~= 'string' or type(row.model) ~= 'string'
    or not numbers(row.charges, { 'amountMicros', 'unavailableSamples' })
    or not numbers(row.tokens, { 'actualInputTokens', 'actualOutputTokens', 'estimatedInputTokens', 'estimatedOutputTokens', 'unavailableSamples' }) then return nil end
  end
  for _, row in cost.breakdown.byWorkKind do if type(row) ~= 'table' or type(row.workKind) ~= 'string' or type(row.activeMs) ~= 'number' then return nil end end
  for _, row in cost.quota.entries do if type(row) ~= 'table' or type(row.plan) ~= 'string' or type(row.units) ~= 'number' or type(row.unit) ~= 'string' then return nil end end
 end
 return value :: Model
end

local function parseIndex(value: unknown): Index?
 if not prModels.parseIndex(value) or type(value) ~= 'table' or type(value.briefs) ~= 'table' then return nil end
 for _, brief in value.briefs do if type(brief) ~= 'table' or type(brief.detailFile) ~= 'string' then return nil end end
 return value :: Index
end
local function parseBrief(value: unknown): Brief?
 if type(value) ~= 'table' or type(value.title) ~= 'string' or type(value.revision) ~= 'number' or type(value.lines) ~= 'table' then return nil end
 for _, line in value.lines do if type(line) ~= 'table' or type(line.id) ~= 'string' or type(line.number) ~= 'number' or type(line.text) ~= 'string' or type(line.kind) ~= 'string' or type(line.isNew) ~= 'boolean' then return nil end end
 return value :: Brief
end
local function detailPath(state: State, file: string): string?
 if not string.match(file, '^[%w%%_.-]+%.json$') then return nil end
 local parent = string.match(state.view.path, '^(.*)/[^/]+$')
 return if parent then parent .. '/' .. file else nil
end
local function related(state: State, cx: BlockCx)
 state.prMatch = false
 local model = state.view.model
 local index = state.index
 if not model or not index or index.status ~= 'ready' or not index.model then return end
 local brief = if model.requestId then index.model.briefs[model.requestId] else nil
 local briefPath = if brief then detailPath(state, brief.detailFile) else nil
 if briefPath and (not state.brief or state.brief.path ~= briefPath) then
  if state.stopBrief then state.stopBrief() end
  state.brief = views.create(briefPath, 'brief', parseBrief); views.refresh(state.brief); state.stopBrief = views.watch(state.brief, cx)
 end
 local path = prModels.taskDetailPath(state.view.path, model.header.id, index.model)
 state.prMatch = path ~= nil
 if not path and state.pr then if state.stopPr then state.stopPr() end; state.pr = nil; state.stopPr = nil end
 if not brief and state.brief then if state.stopBrief then state.stopBrief() end; state.brief = nil; state.stopBrief = nil end
 if path and (not state.pr or state.pr.path ~= path) then
  if state.stopPr then state.stopPr() end
  state.stopPr = nil
  state.pr = prModels.forTask(state.view.path, model.header.id, index.model)
  if state.pr then state.stopPr = views.watch(state.pr, cx) end
 end
end
local function prReady(state: State): boolean
 return state.prMatch and state.view.status == 'ready' and state.index ~= nil and state.index.status == 'ready' and state.pr ~= nil and state.pr.status == 'ready' and state.pr.model ~= nil and state.view.model ~= nil and state.pr.model.header.taskId == state.view.model.header.id
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
local function measuredTokens(known: number, unavailable: number): string
 return if unavailable == 0 then tostring(known) elseif known == 0 then 'unavailable' else tostring(known) .. ' + unavailable'
end
local function measuredCharge(amount: number, unavailable: number): string
 local known = string.format('$%.2f', amount / 1000000)
 return if unavailable == 0 then known elseif amount == 0 then 'unavailable' else known .. ' + unavailable'
end
local function costNode(model: Model): Node
 local cost = model.cost
 if not cost or not cost.recorded then return text('Usage receipt unavailable. No recorded task usage yet.', 'muted') end
 local rows = { text('Additional charges · ' .. measuredCharge(cost.charges.amountMicros, cost.charges.unavailableSamples), 'strong') }
 for _, provider in cost.breakdown.byProvider do
  table.insert(rows, text(string.format('%s / %s · %s in · %s out · %s', provider.provider, provider.model,
   measuredTokens(provider.tokens.actualInputTokens + provider.tokens.estimatedInputTokens, provider.tokens.unavailableSamples),
   measuredTokens(provider.tokens.actualOutputTokens + provider.tokens.estimatedOutputTokens, provider.tokens.unavailableSamples), measuredCharge(provider.charges.amountMicros, provider.charges.unavailableSamples))))
 end
 table.insert(rows, text(string.format('Tokens · %s actual input / %s actual output · %s estimated input / %s estimated output',
  measuredTokens(cost.tokens.actualInputTokens, cost.tokens.unavailableSamples), measuredTokens(cost.tokens.actualOutputTokens, cost.tokens.unavailableSamples), measuredTokens(cost.tokens.estimatedInputTokens, cost.tokens.unavailableSamples), measuredTokens(cost.tokens.estimatedOutputTokens, cost.tokens.unavailableSamples)), 'muted'))
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
  if not model.requestId then return text('No brief is linked to this task yet.', 'muted') end
  local brief = state.brief
  if not brief or not brief.model then return ui.col({ text('Brief detail unavailable. Wait for its saved view.', 'muted'), button('Open brief', 'open-brief') }) end
  local rows = { text(brief.model.title .. ' · revision ' .. brief.model.revision, 'strong'), button('Open brief to review or comment', 'open-brief') }
  if brief.status ~= 'ready' then table.insert(rows, text('Brief detail unavailable. Showing the last saved draft.', 'warn')) end
  for _, line in brief.model.lines do table.insert(rows, ui.el('div', { key = line.id, class = 'tt-brief-line' }, { text(tostring(line.number), 'muted'), if line.kind == 'heading' then text(line.text, 'strong') else ui.md(line.text), text(if line.isNew then 'NEW' else '', 'accent') })) end
  return ui.col(rows)
 elseif state.tab == 'Diff' or state.tab == 'PR' then
  if state.pr and state.pr.model then
   local content = prContent.view(state.prContent, state.pr.model, prReady(state), 'main.content')
   return ui.col({ content.main, content.dock })
  end
  return ui.col({ text(if model.pullRequest then 'Open the PR pane to read the description, diff and review threads.' else 'No pull request is available yet.', 'muted'),
   if model.pullRequest then button('Open PR #' .. model.pullRequest.number, 'open-pr') else text('The branch is ' .. (model.header.branch or 'unavailable'), 'muted') })
 elseif state.tab == 'Cost' then return costNode(model) end
 return text('Choose a tab.', 'muted')
end

local function run(state: State, cx: BlockCx, action: { [string]: unknown }, clear: boolean?)
 if state.view.status ~= 'ready' then return end
 local sent = rt.act(cx, state.origin, action, function(outcome)
  if clear and outcome and outcome.status == 'done' then state.field = fields.create('', true) end
  cx:render()
 end, rt.TASK)
 if sent then cx:render() end
end
local function invokePr(state: State, cx: BlockCx): prContent.Invoke
 return function(action, done)
  local function refused()
   state.prContent.diff.busy = false
   if action.verb == 'review-submit' and done then done(nil) end
  end
  if not state.pr or not state.pr.model or not prReady(state) or not prContent.ready(state.prContent, state.pr.model, true) then refused(); return end
  if action.verb == 'open' then run(state, cx, action); return end
  local sent = rt.act(cx, state.origin, action, function(outcome)
   state.prContent.diff.busy = false
   if done then done(outcome) end
   cx:render()
  end, rt.PR)
  if not sent then refused() end
 end
end

local function send(state: State, cx: BlockCx)
 local model = state.view.model
 if model and string.match(state.field.text, '%S') then run(state, cx, { verb = 'steer', taskId = model.header.id, text = state.field.text }, true) end
end
local block: BlockDef<State> = {
 init = function(cx, args)
  local state: State = { origin = rt.origin(args), prContent = prContent.create(), prMatch = false, view = views.create(args[1] or '', 'task', parse), field = fields.create('', true), tab = 'Overview', editing = false }
  local root = views.index(state.view.path)
  views.refresh(state.view); views.watch(state.view, cx)
  if root ~= '' then state.index = views.create(root, 'panel', parseIndex); views.refresh(state.index); views.watch(state.index, cx) end
  return state
 end,
 title = function(state) return if state.view.model then state.view.model.header.title else 'Task' end,
 view = function(state, cx)
  related(state, cx)
  local model = state.view.model
  if not model then return { main = ui.el('div', { class = 'tt-page' }, {
   ui.el('div', { class = 'tt-title-row' }, { ui.el('h1', { text = 'Task unavailable' }), button('← Orchestrator', 'orchestrator') }),
   text('Task view unavailable. Waiting for its saved detail file.', 'warn'),
  }) } end
  if not table.find(model.tabs, state.tab) then state.tab = 'Overview' end
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
    button(if state.origin.busy then 'Sending…' else 'Send ↑', 'send', true) }),
  }))
  return { main = ui.el('div', { class = 'tt-page' }, children) }
 end,
 event = function(state, ev, cx)
  if (state.tab == 'Diff' or state.tab == 'PR') and not state.editing and state.pr and state.pr.model and prContent.event(state.prContent, state.pr.model, prReady(state), ev, cx, invokePr(state, cx)) then cx:render(); return end
  if ev.ev == 'focus' then state.editing = string.find(ev.id, 'worker%-message$') ~= nil; return end
  if ev.ev ~= 'action' then return end
  local action = ev.act .. (if ev.value and ev.value ~= '' then '=' .. ev.value else '')
  local tab = string.match(action, '^tab=(.+)$')
  if tab and state.view.model and table.find(state.view.model.tabs, tab) then state.tab = tab; state.editing = false; if tab == 'Diff' then state.prContent.tab = 'Diff' elseif tab == 'PR' then state.prContent.tab = 'Description' end; cx:render(); return end
  if action == 'focus-message' or action == 'steer' then state.editing = true; cx:frame({ { 'focus', 'main.worker-message' } }); cx:render(); return end
  if action == 'orchestrator' then rt.act(cx, state.origin, { verb = 'open', ref = { kind = 'orchestrator' } }); return end
  if action == 'send' then send(state, cx); return end
  local model = state.view.model
  if not model then return end
  if action == 'restart' and model.stuck then run(state, cx, { verb = 'restart', taskId = model.header.id })
  elseif action == 'open-brief' and model.requestId then run(state, cx, { verb = 'open', ref = { kind = 'brief', requestId = model.requestId } })
  elseif action == 'open-pr' and model.pullRequest then run(state, cx, { verb = 'open', ref = { kind = 'pr', number = model.pullRequest.number } })
  end
 end,
 key = function(state, key, cx)
  if not state.editing then
   if (state.tab == 'Diff' or state.tab == 'PR') and state.pr and state.pr.model then return prContent.key(state.prContent, state.pr.model, prReady(state), key, cx, invokePr(state, cx)) end
   return false
  end
  local outcome = fields.key(state.field, key)
  if outcome == 'submit' then send(state, cx)
  elseif outcome == 'cancel' or outcome == 'next' then state.editing = false; cx:render()
  elseif outcome == 'changed' then cx:render() end
  return outcome ~= 'ignored'
 end,
}
return block
