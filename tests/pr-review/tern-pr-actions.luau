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
  if raw == '{"posted":true,"url":"https://github.com/acme/app/pull/281#pullrequestreview-1"}' then return {posted=true,url='https://github.com/acme/app/pull/281#pullrequestreview-1'} end
  if raw == '{"posted":false,"message":"PR head moved"}' then return {posted=false,message='PR head moved'} end
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
local args={'/custom home/native-views/project/pr-review-1.json','42','/original repo','opaque-window','/custom home/native-views/project.json'}
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
assert(table.concat(pending[1].argv,'|')=='/bin/sh|native-input.sh|review-submit|review-1|--pane|123|--cwd|/original repo|--home|/custom home|--window|opaque-window')
assert(pending[1].opts.stdin.reviewHead=='abc123' and pending[1].opts.stdin.reviewGeneration==0)
assert(pending[1].opts.stdin.summary=='My edited summary 日本語')
pending[1].callback({status=1,stdout='',stderr='CLI refused'})
preserved(state)
assert(toasts[#toasts].message=='CLI refused' and #pending==1)
post(state)
assert(#pending==2)
pending[2].callback({status=0,stdout='{"posted":false,"message":"PR head moved"}',stderr=''})
preserved(state)
assert(toasts[#toasts].message=='PR head moved' and #pending==2)
post(state)
pending[3].callback({status=0,stdout='malformed',stderr=''})
preserved(state)
assert(string.find(toasts[#toasts].message,'No posted review receipt') and #pending==3)
post(state)
pending[4].callback({status=0,stdout='{"posted":true,"url":"https://github.com/acme/app/pull/281#pullrequestreview-1"}',stderr=''})
assert(state.content.submitted and not state.content.posting and exits==1 and #pending==4)
post(state); assert(#pending==4)
exits=0
local failedStart=create()
startFailure=true
post(failedStart)
preserved(failedStart)
assert(string.find(toasts[#toasts].message,'Could not spawn') and #pending==4)
startFailure=false
local invalidOrigin=create(); invalidOrigin.home=''
post(invalidOrigin)
preserved(invalidOrigin)
assert(#pending==4)
-- Embedded content records receipt success without closing its hosting task pane.
local embedded=content.create(); content.view(embedded,model,true)
local complete=nil
content.event(embedded,model,true,{ev='action',act='pr-post'},cx,function(_,_,_,done) complete=done end)
assert(embedded.posting and complete~=nil)
complete({status=0,stdout='{"posted":true,"url":"https://github.com/acme/app/pull/281#pullrequestreview-1"}',stderr=''})
assert(embedded.submitted and not embedded.posting and exits==0)
print('PR action result, home forwarding and draft retention checks passed')
