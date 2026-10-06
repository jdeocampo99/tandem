--!strict
local files=require("./view-file")
local nav=require("./navigation")
type Row={key:string,title:string,state:string,stage:string,time:string?,model:string?,detail:string?,secondary:string,target:{kind:string,taskId:string?,requestId:string?,number:number?},pullRequest:{number:number,url:string}?}
type Project={repoPath:string,name:string,status:string,current:boolean,needsYou:number,shortcut:string?,offline:boolean}
type Panel={header:{title:string,otherProjectsNeedYou:number,bellCount:number,fiveHourLabel:string,fiveHour:{remainingPercent:number|string,resetInMs:number|string}?,projects:{Project}},sections:{{title:string,count:number,rows:{Row}}},footer:string?}
type Bundle={panel:Panel}
type State={file:files.View<Bundle>,origin:nav.Origin,dropdown:boolean,selected:number}
local function parse(value:unknown): Bundle?
 if type(value)~="table" or type(value.panel)~="table" then return nil end
 local panel=value.panel
 if type(panel.header)~="table" or type(panel.header.title)~="string" or type(panel.header.projects)~="table" or type(panel.header.bellCount)~="number" or type(panel.header.fiveHourLabel)~="string" or type(panel.sections)~="table" then return nil end
 for _,section in panel.sections do
  if type(section.title)~="string" or type(section.rows)~="table" or type(section.count)~="number" then return nil end
  for _,row in section.rows do
   if type(row.key)~="string" or type(row.title)~="string" or type(row.stage)~="string" or type(row.secondary)~="string" or type(row.target)~="table" then return nil end
  end
 end
 for _,project in panel.header.projects do if type(project.repoPath)~="string" or type(project.name)~="string" or type(project.status)~="string" or type(project.needsYou)~="number" then return nil end end
 return value :: Bundle
end
local function el(class:string,children:{Node},action:string?,key:string?):Node
 return tern.ui.node("el",{class=class,key=key,actions=if action then {click=action} else nil},children)
end
local function text(value:string,class:string?):Node
 return el(class or "tdp-text",{tern.ui.text({tern.ui.span(value)})})
end
local function rows(state:State):{Row}
 local result={}
 if state.file.model then for _,section in state.file.model.panel.sections do for _,row in section.rows do table.insert(result,row) end end end
 return result
end
local function activate(state:State,cx:BlockCx,index:number)
 if state.file.status~="ready" then return end
 local row=rows(state)[index]
 if not row then return end
 local target=row.target
 if target.kind=="task" and target.taskId then nav.run(state.origin,cx,{"open","task",target.taskId})
 elseif target.kind=="brief" and target.requestId then nav.run(state.origin,cx,{"open","brief",target.requestId})
 elseif target.kind=="pr" and target.number then nav.run(state.origin,cx,{"open","pr",tostring(target.number)}) end
end
local def:BlockDef<State> ={
 init=function(cx,args,_saved)
  local origin=nav.origin(args)
  local state={file=files.create(origin.path,"panel",parse),origin=origin,dropdown=false,selected=1}
  files.watch(state.file,cx)
  return state
 end,
 title=function() return "Tandem panel" end,
 view=function(state,_cx)
  local model=state.file.model
  if not model then return {main=text("Waiting for Tandem's project snapshot…","tdp-unavailable")} end
  local panel=model.panel
  local header=panel.header
  local name={text(header.title,"tdp-project-title")}
  if header.otherProjectsNeedYou>0 then table.insert(name,text(tostring(header.otherProjectsNeedYou),"tdp-count")) end
  local meter=header.fiveHour
  local limit=header.fiveHourLabel
  local head=el("tdp-header",{
   el("tdp-switch",name,"projects"),
   el("tdp-limit",{text(limit,"tdp-dim"),el("tdp-meter",{tern.ui.node("el",{class="tdp-meter-fill",grow=if meter and type(meter.remainingPercent)=="number" then 100-meter.remainingPercent else 0}),tern.ui.node("el",{grow=if meter and type(meter.remainingPercent)=="number" then meter.remainingPercent else 100})})},"usage"),
   el("tdp-icon",{text("🔔︎ " .. tostring(header.bellCount))},"inbox"),
   el("tdp-icon",{text("⎇")},"prs"),el("tdp-icon",{text("▦")},"board")})
  local body={head}
  if state.file.status~="ready" then table.insert(body,text("View unavailable · actions paused","tdp-unavailable")) end
  local index=0
  for _,section in panel.sections do
   table.insert(body,text(section.title .. " · " .. tostring(section.count),if section.title=="Needs you" then "tdp-section tdp-needs" else "tdp-section"))
   for _,row in section.rows do
    index+=1
    local second={text(row.secondary,"tdp-secondary")}
    if row.pullRequest then second={text((row.model or "") .. " · " .. (row.detail or ""),"tdp-secondary"),el("tdp-pr",{text("#" .. tostring(row.pullRequest.number) .. " ↗")},"url:" .. tostring(index))} end
    table.insert(body,el("tdp-row" .. (if state.selected==index then " tdp-selected" else ""),{
     el("tdp-primary",{text("●","tdp-dot tdp-" .. row.state),text(row.title,"tdp-name"),text(row.stage,"tdp-stage"),text(row.time or "","tdp-time")}),el("tdp-second",second)},"row:" .. tostring(index),row.key))
   end
  end
  if panel.footer then table.insert(body,text(panel.footer,"tdp-footer")) end
  local layer:Node?=nil
  if state.dropdown then
   local items={}
   for number,project in header.projects do
    local cells={text(if project.current then "✓" else " ","tdp-check"),el("tdp-project-copy",{text(project.name,"tdp-project-name"),text(project.status,"tdp-dim")})}
    if project.needsYou>0 then table.insert(cells,text(tostring(project.needsYou),"tdp-count")) end
    table.insert(cells,text(project.shortcut or "","tdp-shortcut"))
    table.insert(items,el("tdp-project-row",cells,if not project.offline then "project:repo:" .. project.repoPath else nil))
   end
   table.insert(items,el("tdp-project-open",{text("+ Open another project…")},"open-project"))
   table.insert(items,text("⌘⇧[ / ⌘⇧] previous / next project","tdp-project-hint"))
   layer=el("tdp-dropdown",items)
  end
  return {main=tern.ui.col({el("tdp-panel",body)}),layer=if layer then tern.ui.col({layer}) else nil}
 end,
 key=function(state,key,cx)
  if key.name=="escape" then state.dropdown=false; return true end
  if key.name=="down" or key.name=="j" then state.selected=math.min(#rows(state),state.selected+1); return true end
  if key.name=="up" or key.name=="k" then state.selected=math.max(1,state.selected-1); return true end
  if key.name=="enter" then activate(state,cx,state.selected); return true end
  return false
 end,
 event=function(state,event,cx)
  if event.ev~="action" then return end
  local command=event.act or ""
  if command=="projects" then state.dropdown=not state.dropdown; return end
  if state.file.status~="ready" then return end
  local index=string.match(command,"^row:(%d+)$")
  if index then state.selected=tonumber(index); activate(state,cx,state.selected); return end
  local urlIndex=string.match(command,"^url:(%d+)$")
  if urlIndex then local row=rows(state)[tonumber(urlIndex)]; if row and row.pullRequest then cx:open(row.pullRequest.url) end; return end
  local project=string.match(command,"^project:(repo:/.*)$")
  if project then nav.run(state.origin,cx,{"project",project}); state.dropdown=false
  elseif command=="inbox" or command=="open-project" then nav.run(state.origin,cx,{"view-file",nav.root(state.origin) .. "#" .. command})
  elseif command=="prs" or command=="board" or command=="usage" then nav.run(state.origin,cx,{command}) end
 end,
}
return def
