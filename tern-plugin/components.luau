--!strict
local M = {}
function M.button(text: string, action: string, tone: string?): Node
 return tern.ui.node("badge", { text = text, tone = tone or "muted", actions = { click = action } })
end
function M.text(text: string, tone: string?): Node
 return tern.ui.text({ tern.ui.span(text, tone or "") })
end
function M.keyed(node: Node, key: string): Node
 local props = node.p or {}
 props.key = key
 node.p = props
 return node
end
return M
