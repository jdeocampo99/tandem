--!strict
local models = require('./pr-model')
local content = require('./pr-content')
local diff = require('./pr-diff')
local fields = require('./text-field')
local model = models.parse(tern.json.decode(tern.fs.read('fixture.json')).model)
assert(model ~= nil)
assert(models.parse({header={}}) == nil)
local state = content.create()
local view = content.view(state, model, true)
assert(view.main ~= nil)
local calls = {}
local frames = {}
local cx = {pane=1,render=function() end,frame=function(_,ops) table.insert(frames,ops) end,open=function(_,url) table.insert(calls,{url=url}) end}
local invoke = function(verb,id,payload,done) table.insert(calls,{verb=verb,id=id,payload=payload}); if done then done() end end
assert(content.event(state,model,true,{ev='action',act='pr-tab',value='Diff'},cx,invoke))
assert(state.tab == 'Diff')
assert(not content.event(state,model,false,{ev='action',act='pr-line',value='2'},cx,invoke))
assert(content.event(state,model,true,{ev='action',act='pr-line',value='2'},cx,invoke))
fields.key(state.diff.editor,{name='paste',text='Typed error? 日本語 😀',ctrl=false,meta=false,alt=false,shift=false})
assert(content.event(state,model,true,{ev='action',act='pr-save'},cx,invoke))
assert(calls[1].verb == 'pr-comment' and calls[1].id == model.header.taskId)
assert(calls[1].payload.comments[1].file == model.files[1].path and calls[1].payload.comments[1].line == 1)
assert(calls[1].payload.comments[1].text == 'Typed error? 日本語 😀')
assert(state.diff.yours[1].sent)
model.header.head = 'moved'
assert(not content.ready(state,model,true))
assert(not content.event(state,model,true,{ev='action',act='pr-line',value='2'},cx,invoke))
model.header.head = 'abc123'
model.commentDestination='review'
model.review={taskId='review-1',generation=1,head='abc123',currentHead='abc123',posted=false,intent='Port',summary='Fix guard',drafts={{id='draft-1',file=model.files[1].path,line=1,severity='blocking',body='Guard'}},concerns={},notes={}}
state=content.create(); content.view(state,model,true)
assert(content.event(state,model,true,{ev='action',act='pr-keep',value='draft-1'},cx,invoke))
assert(content.event(state,model,true,{ev='action',act='pr-line',value='2'},cx,invoke))
fields.key(state.diff.editor,{name='paste',text='My review comment',ctrl=false,meta=false,alt=false,shift=false})
assert(content.event(state,model,true,{ev='action',act='pr-save'},cx,invoke))
assert(#calls == 1 and #state.diff.yours == 1)
assert(content.event(state,model,true,{ev='action',act='pr-verdict',value='request-changes'},cx,invoke))
assert(content.event(state,model,true,{ev='action',act='pr-post'},cx,invoke))
assert(calls[2].verb == 'review-submit' and calls[2].payload.verdict == 'request-changes')
assert(calls[2].payload.drafts[1].decision == 'post' and calls[2].payload.yours[1].body == 'My review comment')
assert(state.submitted)
content.event(state,model,true,{ev='action',act='pr-post'},cx,invoke)
assert(#calls == 2)
state=content.create();content.view(state,model,true)
model.review.generation=2
assert(not content.ready(state,model,true))
content.event(state,model,true,{ev='action',act='pr-post'},cx,invoke)
assert(#calls == 2)
tern.fs.write('results.json',tern.json.encode({comment=true,review=true,stale=true}))
