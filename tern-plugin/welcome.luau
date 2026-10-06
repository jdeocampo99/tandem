--!strict
local nav=require("./navigation")
type State={origin:nav.Origin}
local def:BlockDef<State> ={
 init=function(_cx,args,_saved) return {origin=nav.origin(args)} end,
 title=function() return "Welcome to Tandem" end,
 view=function(_state,_cx) return {main=tern.ui.node("stack",{}, {tern.ui.node("md",{text="# Welcome to Tandem\n\nTell the orchestrator what you want to work on. The panel keeps your tasks, approvals and pull requests close by."}),tern.ui.node("badge",{text="Start a request",actions={click="start"}})})} end,
 event=function(state,event,cx) if event.act=="start" then nav.run(state.origin,cx,{"new-request"}) end end,
}
return def
