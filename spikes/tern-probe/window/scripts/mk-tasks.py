import json,sys,time
n=int(sys.argv[1]) if len(sys.argv)>1 else 1
json.dump({"stamp":int(time.time()*1000),"tasks":[
 {"id":"101","title":"Add Tern backend","stage":"implementing"},
 {"id":"102","title":"Review PR 280","stage":"review","needs":"approval"},
 {"id":"103","title":"Fix panel width v%d"%n,"stage":"blocked","needs":"answer"}]},open("/tmp/tern-window-test/tasks.json.tmp","w"))
import os; os.rename("/tmp/tern-window-test/tasks.json.tmp","/tmp/tern-window-test/tasks.json")
