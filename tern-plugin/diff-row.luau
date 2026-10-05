--!strict
local ui = tern.ui
local M = {}
export type Line = { key: string, old: number?, new: number?, code: string, kind: "add" | "del" | "ctx" }
function M.row(line: Line, commentAction: string?, cards: { Node }?): Node
 local cells = {
  ui.el("span", { class = "tdm-gutter", text = if line.old then tostring(line.old) else "" }),
  ui.el("span", { class = "tdm-gutter", text = if line.new then tostring(line.new) else "" }),
  ui.el("span", { class = "tdm-code", text = line.code }),
 }
 if commentAction then table.insert(cells, ui.el("button", {
  class = "tdm-plus", text = "+", title = "Comment on this line", actions = { click = commentAction },
 })) end
 local children = { ui.el("div", { class = "tdm-line" }, cells) }
 for i, card in cards or {} do
  table.insert(children, ui.el("div", { class = "tdm-thread", key = "thread-" .. i }, { card }))
 end
 return ui.el("div", { class = "tdm-diff-row tdm-" .. line.kind, key = line.key }, children)
end
function M.card(key: string, author: string, body: string, actions: { Node }?): Node
 return ui.el("div", { class = "tdm-comment", key = key }, {
  ui.text({ ui.span(author, "strong") }), ui.md(body), ui.row(actions or {}),
 })
end
return M
