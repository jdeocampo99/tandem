--!strict
-- External Tern UI/process/JSON boundaries only; the bundled modules are production code.
local pending = {}
local exits = 0
local toasts = {}
local startFailure = false
local model = {
 header={repo='acme/app',number=281,title='Port',url='https://github.com/acme/app/pull/281',head='abc123',draft=false,next='Your review',taskId='review-1',commits=1,additions=1,deletions=0,unresolved=0},
 readAt='2030-01-01T12:00:00Z',tabs={'Description','Diff'},checks={},tour={},unanchoredThreads={},
 description={markdown='Port',blocks={'Port'},conversation={}},files={},commentDestination='review',
 review={taskId='review-1',generation=0,head='abc123',currentHead='abc123',posted=false,intent='Port',summary='Original summary',drafts={{id='d1',file='port.ts',line=1,severity='blocking',body='Guard'}},concerns={},notes={}},
}
tern.ui = {
 node=function(kind,props) return {k=kind,p=props} end,
 el=function(kind,props,children) return {k=kind,p=props,c=children} end,
 row=function(children) return {k='row',c=children} end,
 col=function(children) return {k='col',c=children} end,
 span=function(text) return {text=text} end,
 text=function(children) return {k='text',c=children} end,
 rule=function(text) return {k='rule',text=text} end,
 md=function(text) return {k='md',text=text} end,
}
tern.now=function() return 0 end
tern.timer=function() return {cancel=function() end} end
tern.fs={read=function() return 'detail' end}
tern.json={
 array=function(value) return value end,
 encode=function(value) return value end,
 decode=function(raw)
  if raw == 'detail' then return {version=1,kind='pr',revision='revision',model=model} end
  if raw == 'posted' then return {status='done',notice={code='review-posted',text='Posted: https://github.com/acme/app/pull/281#pullrequestreview-1'}} end
  if raw == 'moved' then return {status='kept',notice={code='review-unconfirmed',text='PR head moved'}} end
  if raw == 'done' then return {status='done'} end
  if raw == uncertainOutput then return {status='kept',notice={code='review-unconfirmed',text=uncertainMessage}} end
  error('Unreadable JSON')
 end,
}
tern.process={run=function(argv,opts,callback)
 if startFailure then error('Could not spawn') end
 table.insert(pending,{argv=argv,opts=opts,callback=callback})
end}
local block = loadModule('./pr')
local views = loadModule('./view-file')
local content = loadModule('./pr-content')
local cx={pane=123,render=function() end,exit=function(_,code) assert(code==0); exits+=1 end,
 toast=function(_,level,title,message) table.insert(toasts,{level=level,title=title,message=message}) end}
-- Tandem's launch context, which the block echoes back verbatim and never reads.
local ctx='{"coordinator":"42","cwd":"/original repo","home":"/custom home","index":"/custom home/native-views/project.json","window":"opaque-window"}'
local args={'/custom home/native-views/project/pr-review-1.json',ctx,'/custom home/native-views/project.json'}
local function create()
 local state=block.init(cx,args,nil)
 assert(views.refresh(state.view) and state.view.status=='ready')
 block.view(state,cx)
 state.content.summary.text='My edited summary 日本語'
 state.content.diff.decisions.d1='post'
 table.insert(state.content.diff.yours,{id='u1',file='port.ts',line=1,body='My draft',rowId='r1',sent=false})
 return state
end
local function post(state) block.event(state,{ev='action',act='pr-post'},cx) end
local function preserved(state)
 assert(not state.content.posting and not state.content.submitted and exits==0)
 assert(state.content.summary.text=='My edited summary 日本語')
 assert(state.content.diff.decisions.d1=='post' and state.content.diff.yours[1].body=='My draft')
end
local state=create()
post(state); post(state)
assert(#pending==1 and state.content.posting)
assert(table.concat(pending[1].argv,'|')=='/bin/sh|tandem.sh|native|act')
local sent=pending[1].opts.stdin
assert(sent.v==1 and sent.origin.pane=='123' and sent.origin.ctx==ctx)
assert(sent.action.verb=='review-submit' and sent.action.taskId=='review-1')
assert(sent.action.reviewHead=='abc123' and sent.action.reviewGeneration==0)
assert(sent.action.submission.summary=='My edited summary 日本語')
pending[1].callback({status=1,stdout='',stderr='CLI refused'})
preserved(state)
assert(toasts[#toasts].message=='CLI refused' and #pending==1)
post(state)
assert(#pending==2)
pending[2].callback({status=0,stdout='moved',stderr=''})
preserved(state)
assert(toasts[#toasts].message=='PR head moved' and #pending==2)
local refusalMessage=toasts[#toasts].message
post(state)
pending[3].callback({status=0,stdout='malformed',stderr=''})
preserved(state)
assert(string.find(toasts[#toasts].message,'no outcome') and #pending==3)
post(state)
pending[4].callback({status=0,stdout='posted',stderr=''})
assert(state.content.submitted and not state.content.posting and exits==1 and #pending==4)
post(state); assert(#pending==4)
exits=0
local failedStart=create()
startFailure=true
post(failedStart)
preserved(failedStart)
assert(string.find(toasts[#toasts].message,'Could not spawn') and #pending==4)
startFailure=false
-- Service-owned uncertainty guidance remains distinct from a definite refusal.
local uncertain=create()
post(uncertain)
assert(#pending==5)
pending[5].callback({status=0,stdout=uncertainOutput,stderr=''})
preserved(uncertain)
assert(toasts[#toasts].message==uncertainMessage and toasts[#toasts].message~=refusalMessage)
assert(string.find(toasts[#toasts].message,'may or may not have received') and string.find(toasts[#toasts].message,'Both require your confirmation'))
block.view(uncertain,cx)
assert(#pending==5) -- Neither completion nor redraw invokes a retry.
local stale=create()
post(stale)
pending[6].callback({status=2,stdout='',stderr='The displayed PR review is stale; reopen the pane before submitting.'})
preserved(stale)
assert(toasts[#toasts].message=='The displayed PR review is stale; reopen the pane before submitting.' and #pending==6)
model.review.generation=1
post(stale)
assert(#pending==6 and not stale.content.posting)
model.review.generation=0
-- Embedded content records receipt success without closing its hosting task pane.
local embedded=content.create(); content.view(embedded,model,true)
local complete=nil
content.event(embedded,model,true,{ev='action',act='pr-post'},cx,function(_,done) complete=done end)
assert(embedded.posting and complete~=nil)
complete({status='done'})
assert(embedded.submitted and not embedded.posting and exits==0)
-- Navigation travels the same transport and echoes the same context.
block.event(uncertain,{ev='action',act='pr-task'},cx)
assert(#pending==7)
assert(table.concat(pending[7].argv,'|')=='/bin/sh|tandem.sh|native|act')
local opened=pending[7].opts.stdin
assert(opened.origin.ctx==ctx and opened.action.verb=='open' and opened.action.ref.kind=='task' and opened.action.ref.taskId=='review-1')
pending[7].callback({status=0,stdout='done',stderr=''})
assert(exits==0 and #pending==7)
print('PR action result, context echo and draft retention checks passed')

local savedModel=table.clone(model)
savedModel.header=table.clone(model.header)
-- Reply chooses the exact second thread, including an outdated thread without a line.
model.files={{path='port.ts',additions=1,deletions=0,commentCount=2,rows={{id='r1',row={kind='add',new=1,text='guard();'},drafts={},threads={
 {id='thread-1',file='port.ts',line=1,side='RIGHT',resolved=false,outdated=false,comments={{id='node-11',databaseId=11,author='sam',at='today',body='First'}}},
 {id='thread-2',file='port.ts',line=1,side='RIGHT',resolved=false,outdated=false,comments={{id='node-22',databaseId=22,author='jules',at='today',body='Second'}}},
}}}}}
model.unanchoredThreads={{id='old-thread',file='removed.ts',side='LEFT',resolved=false,outdated=true,comments={{id='node-33',databaseId=33,author='alex',at='yesterday',body='Removed'}}}}
local replies=create(); replies.content.diff.yours={}
assert(content.event(replies.content,model,true,{ev='action',act='pr-reply',value='thread-2'},cx,function() error('Draft must not post') end))
replies.content.diff.editor.text='Second thread reply'
content.event(replies.content,model,true,{ev='action',act='pr-save'},cx,function() error('Draft must not post') end)
assert(replies.content.diff.yours[1].reply.threadId=='thread-2' and replies.content.diff.yours[1].reply.replyTo==22)
content.event(replies.content,model,true,{ev='action',act='pr-reply',value='old-thread'},cx,function() end)
replies.content.diff.editor.text='Outdated reply'
content.event(replies.content,model,true,{ev='action',act='pr-save'},cx,function() end)
local payload=nil
content.event(replies.content,model,true,{ev='action',act='pr-post'},cx,function(action) payload=action.submission end)
assert(#payload.yours==0 and #payload.replies==2)
assert(payload.replies[2].threadId=='old-thread' and payload.replies[2].commentId=='node-33' and payload.replies[2].replyTo==33)
model.header.taskId=nil;model.review=nil;model.commentDestination='read-only';model.readOnlyReason='Read-only: no Tandem task'
local readonly=content.create();content.view(readonly,model,true)
assert(not content.event(readonly,model,true,{ev='action',act='pr-line',value='1'},cx,function() error('Read-only mutation') end))
assert(not content.event(readonly,model,true,{ev='action',act='pr-reply',value='old-thread'},cx,function() error('Read-only mutation') end))
assert(not content.event(readonly,model,true,{ev='action',act='pr-post'},cx,function() error('Read-only mutation') end))
local switch=block.init(cx,args,nil)
views.refresh(switch.view)
switch.index.status='ready';switch.index.model={pullRequests={external={header={repo='acme/app',number=282,title='Watched external PR'},detailFile='pr-282.json'}}}
block.event(switch,{ev='action',act='pr-select',value='acme/app#282'},cx)
local selected=pending[#pending].opts.stdin.action
assert(selected.verb=='open' and selected.ref.kind=='pr' and selected.ref.repo=='acme/app' and selected.ref.number==282)
print('Exact thread replies and taskless read-only guards passed')

for key in model do model[key]=nil end
for key,value in savedModel do model[key]=value end
