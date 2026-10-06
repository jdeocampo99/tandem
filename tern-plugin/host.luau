--!strict
-- Load shared drawing modules at daemon startup, so failures fail plugin readiness before a
-- view opens. Each renderer module returns its typed BlockDef.
require("./view-file")
require("./text-field")
require("./diff-row")
require("./components")

-- Block registrations: one tern.block.define(id, require("./block-file")) line per renderer.
tern.block.define("task", require("./task"))
tern.block.define("task-picker", require("./task-picker"))
