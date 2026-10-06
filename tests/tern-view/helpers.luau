--!strict
local fields = require('./text-field')
local rt = require('./rt')
local diff = require('./diff-row')
local components = require('./components')
local function key(name, text, shift, meta)
 return {name=name,text=text,shift=shift or false,meta=meta or false,ctrl=false,alt=false}
end
local f=fields.create('a😀é')
assert(f.cursor==3)
fields.key(f,key('backspace'));assert(f.text=='a😀')
local n=fields.node(f,'field');assert(n.p.cursor==3 and n.p.anchor==3)
fields.key(f,key('left',nil,true));fields.key(f,key('paste','Z'));assert(f.text=='aZ')
fields.key(f,key('a',nil,false,true));fields.key(f,key('paste','new\nline'));assert(f.text=='new line')
assert(fields.key(f,key('enter'))=='submit')
local multi=fields.create('',true);fields.key(multi,key('enter',nil,true));assert(multi.text=='\n')
assert(fields.key(multi,key('escape'))=='cancel')
local path='test.tandem-view.json'
if tern.fs.exists(path) then tern.fs.remove(path) end
local cx={pane=0,render=function() end}
local function watched()
 local view=rt.watch(cx,path,'index')
 rt.unwatch(cx,view)
 return view
end
assert(watched().status=='unavailable')
tern.fs.write(path,tern.json.encode({v=1,kind='index',epoch='one',seq=1,model={summary='fresh'}}))
local view=watched()
assert(view.status=='ready' and view.seq==1 and view.model.summary=='fresh')
tern.fs.write(path,'invalid')
assert(watched().status=='unavailable')
tern.fs.write(path,tern.json.encode({v=1,kind='task',epoch='one',seq=2,model={summary='after'}}))
assert(watched().status=='unavailable')
local row=diff.row({key='line-1',old=1,new=1,kind='ctx',code='text'},'comment=1',{diff.card('c1','you','hello',{components.button('Reply','reply')})})
assert(#row.c==2 and row.c[1].c[4].p.actions.click=='comment=1')
tern.fs.write('results.json',tern.json.encode({textField=true,loader=true,diff=true}))
