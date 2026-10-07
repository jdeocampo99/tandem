-- Execute the real entry points with a loader that refuses any LOAD-time require/effect.
local definitions, commands, timers = {}, {}, {}
local openRoute, linkRoute
local loading = true
local imports = {}
local function forbidden() error('LOAD performed file, process or layout work') end
local tern = {
 timer = function(_, callback) assert(not loading); table.insert(timers, callback) end,
 block = {define = function(id, def) assert(definitions[id] == nil); definitions[id] = def end},
 on = function(_event, callback) assert(type(callback)=="function") end,
 command = function(def) commands[def.id] = def end,
 route = {open = function(callback) openRoute = callback end, link = function(callback) linkRoute = callback end},
 fs = {read = forbidden, write = forbidden}, process = {run = forbidden},
 ui = {node = forbidden}, getenv = forbidden,
}
local callbackCount = {}
local function hit(name) callbackCount[name] = (callbackCount[name] or 0) + 1 end
local function loadModule(name)
 assert(not loading, 'LOAD eagerly required ' .. name)
 imports[name] = (imports[name] or 0) + 1
 if name == './layout' then return {open = function(req, cx) assert(req.path and cx); return {handled=true} end} end
 if name == './rt' then return {draw = function(view, state, cx) return view(state, cx) end} end
 return {
  init = function(cx, args, saved) assert(cx.token and args[1]=='fixture' and saved=='saved'); hit('init'); return {token=cx.token} end,
  view = function(state, cx) assert(state.token==cx.token); hit('view'); return {main='view'} end,
  title = function(state) assert(state.token); hit('title'); return 'title' end,
  key = function(state, key, cx) assert(state.token==cx.token and key.name=='enter'); hit('key'); return false end,
  event = function(state, event, cx) assert(state.token==cx.token and event.act=='click'); hit('event') end,
  resize = function(state, cols, rows, cx) assert(state.token==cx.token and cols==80 and rows==24); hit('resize') end,
  save = function(state) hit('save'); return state.token end,
 }
end
-- ENTRY_POINTS
assert(openRoute and linkRoute and next(imports)==nil)
local count=0
for _,def in definitions do assert(type(def.init)=='function' and type(def.view)=='function'); count+=1 end
assert(count==10)
count=0
for _,def in commands do assert(type(def.run)=='function'); count+=1 end
assert(count==19 and commands['new-request'] and commands['project-next'] and commands['settings'])
loading=false
assert(openRoute({path='/unrelated.txt'}, {})==nil and next(imports)==nil)
local cx={token='state'}
for id,def in definitions do
 local state=def.init(cx,{'fixture'},'saved')
 assert(imports['./' .. id]==1)
 assert(def.view(state,cx).main=='view' and def.title(state)=='title')
 assert(def.key(state,{name='enter'},cx)==false)
 def.event(state,{act='click'},cx)
 def.resize(state,80,24,cx)
 assert(def.save(state)=='state')
 def.init(cx,{'fixture'},'saved')
 assert(imports['./' .. id]==1, 'second pane reloaded its block')
end
for _,name in {'view','title','key','event','resize','save'} do assert(callbackCount[name]==10) end
assert(callbackCount.init==20)
assert(openRoute({path='/tmp/tern/0a1b/open/ab12.cd34.ticket.json'},{}).handled)
assert(imports['./layout']==nil)
while #timers>0 do table.remove(timers,1)({}) end
assert(imports['./layout']==1)
print('Plugin LOAD is registration-only; lazy callbacks and cached definitions pass')
