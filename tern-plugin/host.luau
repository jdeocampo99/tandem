--!strict
-- LOAD only registers callbacks. Compile a screen and its helpers on its first init.
-- Tern caches required modules; this closure also keeps the definition for every later pane.
local function lazy(load: () -> BlockDef<unknown>): BlockDef<unknown>
 local definition: BlockDef<unknown>?
 local function get(): BlockDef<unknown>
  if not definition then definition = load() end
  return definition :: BlockDef<unknown>
 end
 return {
  init = function(cx, args, saved) return get().init(cx, args, saved) end,
  view = function(state, cx) return get().view(state, cx) end,
  title = function(state)
   local callback = get().title
   return if callback then callback(state) else nil
  end,
  key = function(state, key, cx)
   local callback = get().key
   return if callback then callback(state, key, cx) else false
  end,
  event = function(state, event, cx)
   local callback = get().event
   if callback then callback(state, event, cx) end
  end,
  resize = function(state, cols, rows, cx)
   local callback = get().resize
   if callback then callback(state, cols, rows, cx) end
  end,
  save = function(state)
   local callback = get().save
   return if callback then callback(state) else nil
  end,
 }
end

tern.block.define("panel", lazy(function() return require("./panel") end))
tern.block.define("welcome", lazy(function() return require("./welcome") end))
tern.block.define("task", lazy(function() return require("./task") end))
tern.block.define("task-picker", lazy(function() return require("./task-picker") end))
tern.block.define("board", lazy(function() return require("./board") end))
tern.block.define("usage", lazy(function() return require("./usage") end))
tern.block.define("catchup", lazy(function() return require("./catchup") end))
tern.block.define("brief", lazy(function() return require("./brief") end))
tern.block.define("pr", lazy(function() return require("./pr") end))
