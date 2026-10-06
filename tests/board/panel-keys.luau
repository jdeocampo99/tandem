-- Only the Tern UI and action transport boundaries are mocked. Render the real panel and board.
local calls = {}
local function node(kind, props, children)
 local seen = {}
 for _, child in children or {} do
  local key = child.p and child.p.key
  if key then
   assert(not seen[key], 'duplicate child key: ' .. key)
   seen[key] = true
  end
 end
 return {kind=kind, p=props or {}, c=children or {}}
end
local tern = {ui={
 node=node,
 el=function(_tag, props, children) return node('el', props, children) end,
 col=function(children) return node('col', {}, children) end,
 text=function(spans) return node('text', {}, {}) end,
 span=function(value) return value end,
}}
local function loadModule(name)
 if name == './view-file' then return {} end
 if name == './rt' then return {
  origin=function(args) return {ctx=args[2] or '', busy=false} end,
  act=function(_cx, _origin, action) table.insert(calls, action); return true end,
 } end
 if name == './screen' then return {
  header=function() return node('header') end,
  status=function() end,
 } end
 if name == './components' then return {
  button=function(label, action) return node('button', {text=label, actions={click=action}}) end,
  text=function(value) return node('text', {text=value}) end,
 } end
 error('unexpected module: ' .. name)
end
-- MODULES
-- MODEL
local panel = loadPanel()
local state = {file={model=bundle, status='ready'}, origin={}, dropdown=true, selected=1}
local rendered = panel.view(state, {})
assert(rendered.main and rendered.layer)
panel.event(state, {ev='action', act='row:1'}, {})
panel.event(state, {ev='action', act='row:2'}, {})
assert(calls[1].verb=='open' and calls[1].ref.kind=='task' and calls[1].ref.taskId=='blocked')
assert(calls[2].verb=='open' and calls[2].ref.kind=='pr' and calls[2].ref.repo=='acme/app' and calls[2].ref.number==284)
panel.event(state, {ev='action', act='project:repo:/work/app'}, {})
assert(calls[3].verb=='project' and calls[3].target.repoPath=='/work/app')
local board = loadBoard()
assert(board.view({view={model=bundle,status='ready'},args={}}, {}).main)
local prCard
for _, lane in bundle.board.lanes do for _, card in lane.cards do
 if card.key=='pr:acme/app#284' then prCard=card end
end end
assert(prCard and prCard.pullRequest.number==284)
board.event({view={model=bundle,status='ready'},args={}}, {ev='action',act='pr',value=prCard.key}, {})
assert(calls[4].verb=='board-link' and calls[4].cardKey==prCard.key)
print('Panel and board child keys and row actions pass')
