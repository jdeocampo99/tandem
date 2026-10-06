--!strict
-- Stub only the Tern JSON/process/toast boundaries; execute the production navigation module.
local output={}
local callback=nil
local calls=0
local exits=0
local toasts={}
tern.json={decode=function(raw)
 if raw=='malformed' then error('Invalid JSON') end
 return output
end}
tern.process={run=function(_argv,_options,done) calls+=1; callback=done end}
local navigation=loadNavigation()
local origin=navigation.origin({'/home/native-views/repo.json','{"coordinator":"42"}','/home/native-views/repo.json'})
local cx={pane=123,toast=function(_,level,title,message) table.insert(toasts,{level=level,title=title,message=message}) end}
local catchup='Project opened, but catch-up is unavailable: fixture catch-up failure'
local retention='Returned to your conversation. An earlier view could not be verified, so its views and recovery record were kept.'
local function finish(value,status,stdout)
 output=value
 callback=nil
 local beforeCalls=calls
 navigation.back(origin,cx,function() exits+=1 end)
 assert(callback~=nil and calls==beforeCalls+1)
 callback({status=status or 0,stdout=stdout or 'result',stderr='CLI refused'})
 assert(calls==beforeCalls+1) -- completion never retries the action
end
finish({opened=true,warnings={retention}})
assert(exits==0 and #toasts==1 and toasts[1].message==retention)
finish({focused=true,project='/other-repo',warnings={catchup}})
assert(exits==1 and #toasts==2 and toasts[2].message==catchup)
finish({entered=true,warnings={catchup}})
assert(exits==2 and #toasts==3 and toasts[3].message==catchup)
finish({focused=true,project='/other-repo',warnings={'Unknown warning'}})
assert(exits==2 and #toasts==4)
finish({entered=true,warnings={catchup,retention}})
assert(exits==2 and #toasts==5)
finish({opened=true,warnings={catchup}}) -- text alone cannot establish a successful project entry
assert(exits==2 and #toasts==6)
finish({entered=true,warnings={false}})
assert(exits==2)
finish({entered=true,warnings='Unreadable warnings'})
assert(exits==2)
finish({},0,'malformed')
assert(exits==2)
finish({})
assert(exits==3)
finish({},1)
assert(exits==3 and toasts[#toasts].level=='error')
print('Navigation warning callback checks passed')
