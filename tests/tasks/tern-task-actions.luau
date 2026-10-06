--!strict
-- Exercise the production task block, including its embedded PR dock and process completion.
local taskBlock = loadModule('./task')
local taskModel = {
 header={id='review-1',title='Review the terminal port',stage='completed',elapsed='12m',returnLabel='← Orchestrator'},
 rightNow={text='Review ready'},stageTrack={},tabs={'Overview','Brief','Progress','Diff','PR','Cost'},
 overview={summary='Review the port',todos={},done=0,total=0,recent={}},
 progress={events={},unreadableEvents=0,checks={},findings={}},message={placeholder='Message the worker…'},
}
local taskPath='/custom home/native-views/project/task-review-1.json'
local indexPath='/custom home/native-views/project.json'
local prPath='/custom home/native-views/project/pr-review-1.json'
local decodeReceipt=tern.json.decode
tern.fs.read=function(path) return path end
tern.json.decode=function(raw)
 if raw==taskPath then return {version=1,kind='task',revision='task-revision',model=taskModel} end
 if raw==indexPath then return {version=1,kind='panel',revision='index-revision',model={briefs={},pullRequests={['acme/app#281']={header=model.header,detailFile='pr-review-1.json'}}}} end
 if raw==prPath then return {version=1,kind='pr',revision='pr-revision',model=model} end
 return decodeReceipt(raw)
end
local function hasText(node,label)
 if node.text==label then return true end
 if node.p and node.p.text==label then return true end
 for _, child in node.c or {} do if hasText(child,label) then return true end end
 return false
end
local function taskCreate()
 local s=taskBlock.init(cx,{taskPath,ctx})
 assert(s.view.status=='ready' and s.index.status=='ready')
 taskBlock.view(s,cx)
 taskBlock.event(s,{ev='action',act='tab',value='PR'},cx)
 local rendered=taskBlock.view(s,cx)
 assert(hasText(rendered.main,'Post')) -- Dock is mounted inside the actual task page.
 s.prContent.summary.text='Edited task review 日本語'
 s.prContent.diff.decisions.d1='post'
 table.insert(s.prContent.diff.yours,{id='u1',file='port.ts',line=1,body='Task draft',rowId='r1',sent=false})
 return s
end
local function taskPost(s) taskBlock.event(s,{ev='action',act='pr-post'},cx) end
local function taskPreserved(s)
 assert(not s.prContent.posting and not s.prContent.submitted and exits==0)
 assert(s.prContent.summary.text=='Edited task review 日本語')
 assert(s.prContent.diff.decisions.d1=='post' and s.prContent.diff.yours[1].body=='Task draft' and not s.prContent.diff.yours[1].sent)
 assert(hasText(taskBlock.view(s,cx).main,'Post'))
end
local taskState=taskCreate()
local before=#pending
taskPost(taskState); taskPost(taskState)
assert(#pending==before+1 and taskState.prContent.posting and taskState.busy)
assert(table.concat(pending[#pending].argv,'|')=='/bin/sh|native-input.sh|review-submit|review-1|--pane|123|--ctx|' .. ctx)
assert(pending[#pending].opts.stdin.reviewHead=='abc123' and pending[#pending].opts.stdin.reviewGeneration==0)
pending[#pending].callback({status=0,stdout='{"posted":false,"message":"PR head moved"}',stderr=''})
taskPreserved(taskState)
assert(not taskState.busy and toasts[#toasts].message=='PR head moved' and #pending==before+1)
taskBlock.event(taskState,{ev='action',act='tab',value='Diff'},cx)
taskBlock.view(taskState,cx)
taskBlock.event(taskState,{ev='action',act='tab',value='PR'},cx)
taskPreserved(taskState)
taskPost(taskState)
assert(#pending==before+2 and taskState.prContent.posting)
pending[#pending].callback({status=7,stdout='',stderr='Review refused'})
taskPreserved(taskState)
assert(not taskState.busy and toasts[#toasts].message=='Review refused' and #pending==before+2)
startFailure=true
taskPost(taskState)
taskPreserved(taskState)
assert(not taskState.busy and string.find(toasts[#toasts].message,'Could not spawn') and #pending==before+2)
startFailure=false
taskState.busy=true
taskPost(taskState)
taskPreserved(taskState)
assert(#pending==before+2)
taskState.busy=false
taskPost(taskState)
assert(#pending==before+3)
pending[#pending].callback({status=0,stdout='{"posted":true,"url":"https://github.com/acme/app/pull/281#pullrequestreview-1"}',stderr=''})
assert(taskState.prContent.submitted and not taskState.prContent.posting and not taskState.busy and exits==0)
assert(hasText(taskBlock.view(taskState,cx).main,'Review already posted'))
taskPost(taskState); assert(#pending==before+3) -- The task remains open without a retry.
print('Embedded task review completion checks passed')
