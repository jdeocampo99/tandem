--!strict
-- The Specialists tab of Settings: the list, the Just-me editor and the checks before Save. The
-- edits are part of setup.luau's draft and hold no state of their own; TypeScript checks every
-- change again when it writes the files, so the checks here only stop what it would refuse.
local ui = tern.ui
local fields = require("./text-field")
local components = require("./components")

export type Content = {label: string, description: string?, instructions: string, steps: {string}}
export type Row = {
 name: string, origin: string, state: string, status: {text: string, tone: string}, hiddenBy: string?,
 shownPath: string?, revision: string?, summary: string?, fields: Content?, problem: string?,
}
export type Limits = {nameLength: number, labelLength: number, descriptionLength: number, contentBytes: number, reserved: {string}}
export type Model = {project: string, homeFolder: string, teamFolder: string, rows: {Row}, problems: {string}, limits: Limits}

-- `id` marks a create and keeps its selection steady while others are added or dropped.
-- `revision` is the row's revision when the form was made; `locked` keeps the name of a saved row
-- or of a copy of a built-in.
export type Form = {
 id: number?, name: fields.Field, label: fields.Field, description: fields.Field, instructions: fields.Field,
 steps: {fields.Field}, revision: string?, locked: boolean,
}
export type Edits = {forms: {[string]: Form}, creates: {Form}, removes: {[string]: string}}
export type Problem = {field: string, text: string}
-- `taken` maps a name a new specialist may not use to why.
export type Ctx = {limits: Limits, creating: boolean, taken: {[string]: string}}

-- The part of setup.luau's State this tab reads and writes.
export type Session = {pick: string?, nextId: number, active: string, fields: {[string]: fields.Field}, order: {string}}

local M = {}

local KIND_ORIGIN: {[string]: string} = {team = "repository", home = "home", ["built-in"] = "built-in"}
local ORIGIN_KIND: {[string]: string} = {repository = "team", home = "home", ["built-in"] = "built-in"}
local ORIGIN_TAG: {[string]: {string}} = {
 repository = {"Team", "setup-tag setup-tag-team"},
 home = {"Just me", "setup-tag setup-tag-me"},
 ["built-in"] = {"Built-in", "setup-tag setup-tag-builtin"},
}
local TONE: {[string]: string} = {muted = "setup-muted", info = "setup-info", error = "setup-error"}

local function trim(text: string): string
 return string.match(text, "^%s*(.-)%s*$") or ""
end

local function plain(text: string): string
 return (string.gsub(trim(text), "\r\n", "\n"))
end

local function texts(list: {fields.Field}): {string}
 local out = {}
 for _, field in list do table.insert(out, trim(field.text)) end
 return out
end

-- UTF-16 units, as text-field and TypeScript count them.
local function units(text: string): number
 if utf8.len(text) == nil then return #text end
 local count = 0
 for _, code in utf8.codes(text) do
  count += if code >= 0x10000 then 2 else 1
 end
 return count
end

local function sorted<V>(map: {[string]: V}): {string}
 local names = {}
 for name in map do table.insert(names, name) end
 table.sort(names)
 return names
end

local function leaf(class: string, text: string, action: string?): Node
 return ui.el("div", {class = class, text = text, actions = if action then {click = action} else nil})
end

local function box(class: string, children: {Node}, key: string?, action: string?): Node
 return ui.el("div", {class = class, key = key, actions = if action then {click = action} else nil}, children)
end

local function input(state: Session, field: fields.Field, key: string, placeholder: string): Node
 state.fields[key] = field
 table.insert(state.order, key)
 return fields.node(field, key, placeholder)
end

local function reflow(state: Session)
 state.active, state.fields, state.order = "", {}, {}
end

local function focus(state: Session, cx: BlockCx, key: string)
 state.active = key
 cx:render()
 pcall(function() cx:frame({{"focus", "main." .. key}}) end)
end

-- Content compared as TypeScript would store it.
local function normal(content: Content): Content
 local description = trim(content.description or "")
 local steps = {}
 for _, step in content.steps do table.insert(steps, trim(step)) end
 return {label = trim(content.label), description = if description == "" then nil else description, instructions = plain(content.instructions), steps = steps}
end

local function contentOf(form: Form): Content
 local description = trim(form.description.text)
 return {
  label = trim(form.label.text), description = if description == "" then nil else description,
  instructions = plain(form.instructions.text), steps = texts(form.steps),
 }
end

local function same(a: Content, b: Content): boolean
 if a.label ~= b.label or (a.description or "") ~= (b.description or "") or a.instructions ~= b.instructions or #a.steps ~= #b.steps then return false end
 for index, step in a.steps do
  if step ~= b.steps[index] then return false end
 end
 return true
end

local function homeRow(model: Model?, name: string): Row?
 if not model then return nil end
 for _, row in model.rows do
  if row.origin == "home" and row.name == name then return row end
 end
 return nil
end

local function pickOf(row: Row): string
 return ORIGIN_KIND[row.origin] .. ":" .. row.name
end

local function findRow(model: Model, pick: string): Row?
 local kind, name = string.match(pick, "^([%a%-]+):(.+)$")
 local origin = if kind then KIND_ORIGIN[kind] else nil
 if not origin or not name then return nil end
 for _, row in model.rows do
  if row.origin == origin and row.name == name then return row end
 end
 return nil
end

local function createId(pick: string): number?
 local text = string.match(pick, "^new:(%d+)$")
 return if text then tonumber(text) else nil
end

local function findCreate(edits: Edits, id: number): Form?
 for _, form in edits.creates do
  if form.id == id then return form end
 end
 return nil
end

-- A row's content when it is something to edit or compare: a ready row.
local function contentOfRow(row: Row?): Content?
 if row == nil or row.state ~= "ready" or row.fields == nil then return nil end
 return normal(row.fields :: Content)
end

local function formFromContent(name: string, content: Content, revision: string?, id: number?, locked: boolean): Form
 local steps = {}
 for _, step in content.steps do table.insert(steps, fields.create(step)) end
 return {
  id = id, name = fields.create(name), label = fields.create(content.label), description = fields.create(content.description or ""),
  instructions = fields.create(content.instructions, true), steps = steps, revision = revision, locked = locked,
 }
end

local function formFrom(row: Row): Form
 return formFromContent(row.name, row.fields :: Content, row.revision, nil, true)
end

local function copyForm(form: Form): Form
 local steps = {}
 for _, step in form.steps do table.insert(steps, fields.create(step.text)) end
 return {
  id = form.id, name = fields.create(form.name.text), label = fields.create(form.label.text), description = fields.create(form.description.text),
  instructions = fields.create(form.instructions.text, true), steps = steps, revision = form.revision, locked = form.locked,
 }
end

function M.empty(): Edits
 return {forms = {}, creates = {}, removes = {}}
end

function M.copy(edits: Edits): Edits
 local forms, creates, removes = {}, {}, {}
 for name, form in edits.forms do forms[name] = copyForm(form) end
 for _, form in edits.creates do table.insert(creates, copyForm(form)) end
 for name, revision in edits.removes do removes[name] = revision end
 return {forms = forms, creates = creates, removes = removes}
end

-- Whether the form of a saved row says something its row does not.
local function changed(model: Model?, name: string, form: Form): boolean
 local content = contentOfRow(homeRow(model, name))
 return content ~= nil and not same(contentOf(form), content)
end

local function formText(form: Form): string
 return table.concat({
  trim(form.name.text), trim(form.label.text), trim(form.description.text), plain(form.instructions.text), table.concat(texts(form.steps), "\28"),
 }, "\30")
end

-- What the answer would say about specialists, as one string: equal strings mean equal answers.
function M.signature(model: Model?, edits: Edits): string
 local parts: {string} = {}
 for _, form in edits.creates do table.insert(parts, "c\30" .. formText(form)) end
 for _, name in sorted(edits.forms) do
  local form = edits.forms[name]
  if edits.removes[name] == nil and changed(model, name, form) then table.insert(parts, "u\30" .. (form.revision or "") .. "\30" .. formText(form)) end
 end
 for _, name in sorted(edits.removes) do table.insert(parts, "r\30" .. name .. "\30" .. edits.removes[name]) end
 return table.concat(parts, "\29")
end

local function fieldsOf(form: Form): {[string]: unknown}
 local content = contentOf(form)
 return {label = content.label, description = content.description, instructions = content.instructions, steps = tern.json.array(content.steps)}
end

-- Every text is sent trimmed, a blank step too: the blocker stops it before it is sent.
function M.answer(model: Model?, edits: Edits): {unknown}
 local changes: {unknown} = {}
 for _, form in edits.creates do
  table.insert(changes, {op = "create", name = trim(form.name.text), fields = fieldsOf(form)})
 end
 for _, name in sorted(edits.forms) do
  local form = edits.forms[name]
  if edits.removes[name] == nil and changed(model, name, form) then
   table.insert(changes, {op = "update", name = name, revision = form.revision, fields = fieldsOf(form)})
  end
 end
 for _, name in sorted(edits.removes) do
  table.insert(changes, {op = "remove", name = name, revision = edits.removes[name]})
 end
 return tern.json.array(changes)
end

local function bytes(form: Form): number
 return #plain(form.instructions.text) + #table.concat(texts(form.steps), "\n")
end

-- Each problem sits under its field: name, label, description, instructions, `step-N`, bytes.
function M.problems(form: Form, ctx: Ctx): {Problem}
 local found: {Problem} = {}
 local function add(field: string, text: string) table.insert(found, {field = field, text = text}) end
 local limits = ctx.limits
 if ctx.creating then
  local name = trim(form.name.text)
  if name == "" then add("name", "Give it a name.")
  elseif string.match(name, "^[a-z0-9][a-z0-9%-]*$") == nil then add("name", "Use lowercase letters, numbers, and hyphens.")
  elseif #name > limits.nameLength then add("name", string.format("Use at most %d characters.", limits.nameLength))
  elseif table.find(limits.reserved, name) then add("name", name .. " is reserved for Tandem. Pick another name.")
  elseif ctx.taken[name] then add("name", ctx.taken[name]) end
 end
 local label = trim(form.label.text)
 if label == "" then add("label", "Give it a label.")
 elseif units(label) > limits.labelLength then add("label", string.format("Use at most %d characters.", limits.labelLength)) end
 local description = trim(form.description.text)
 if description ~= "" and units(description) > limits.descriptionLength then
  add("description", string.format("Use at most %d characters.", limits.descriptionLength))
 end
 local steps = texts(form.steps)
 if plain(form.instructions.text) == "" and #steps == 0 then add("instructions", "Add instructions or at least one step.") end
 local first: {[string]: number} = {}
 for index, step in steps do
  if step == "" then add("step-" .. index, string.format("Step %d is empty.", index))
  elseif first[step] then add("step-" .. index, string.format("Same as step %d.", first[step]))
  else first[step] = index end
 end
 local size = bytes(form)
 if size > limits.contentBytes then add("bytes", string.format("Instructions and steps are %d bytes; the limit is %d.", size, limits.contentBytes)) end
 return found
end

local function context(model: Model, edits: Edits, form: Form): Ctx
 local taken: {[string]: string} = {}
 for _, other in edits.creates do
  local name = trim(other.name.text)
  if other ~= form and name ~= "" then taken[name] = "Another new specialist is named " .. name .. "." end
 end
 for _, row in model.rows do
  if row.origin == "home" then taken[row.name] = "You already have a specialist named " .. row.name .. "." end
 end
 return {limits = model.limits, creating = form.id ~= nil, taken = taken}
end

-- "<name>: <first problem>" for the first new or changed form that cannot be saved.
function M.blocker(model: Model?, edits: Edits): string?
 if not model then return nil end
 local checked: Model = model
 local function check(form: Form, name: string): string?
  local found = M.problems(form, context(checked, edits, form))
  if #found == 0 then return nil end
  return (if name == "" then "New specialist" else name) .. ": " .. found[1].text
 end
 for _, form in edits.creates do
  local reason = check(form, trim(form.name.text))
  if reason then return reason end
 end
 for _, name in sorted(edits.forms) do
  local form = edits.forms[name]
  if edits.removes[name] == nil and changed(model, name, form) then
   local reason = check(form, name)
   if reason then return reason end
  end
 end
 return nil
end

-- Drops what a newer file shows saved: a create a Just-me row now matches, a form its row now
-- equals or lost, a remove whose row is gone. Returns each dropped create's name by id, so the
-- caller can move the selection onto the row.
function M.settle(model: Model, edits: Edits): {[number]: string}
 local saved: {[number]: string} = {}
 local kept: {Form} = {}
 for _, form in edits.creates do
  local name = trim(form.name.text)
  local content = contentOfRow(homeRow(model, name))
  if content ~= nil and same(contentOf(form), content) then
   if form.id then saved[form.id] = name end
  else
   table.insert(kept, form)
  end
 end
 edits.creates = kept
 for name, form in edits.forms do
  local content = contentOfRow(homeRow(model, name))
  if content == nil or same(contentOf(form), content) then edits.forms[name] = nil end
 end
 for name in edits.removes do
  if homeRow(model, name) == nil then edits.removes[name] = nil end
 end
 return saved
end

-- `pick` when it still names a row or a create, else nil.
function M.keep(model: Model?, edits: Edits, pick: string?): string?
 if pick == nil or model == nil then return nil end
 local id = createId(pick)
 if id then return if findCreate(edits, id) then pick else nil end
 return if findRow(model, pick) then pick else nil
end

-- The form a selection edits: a create, or a saved Just-me row's, made on first use.
local function formFor(model: Model, edits: Edits, pick: string): (Form?, Row?)
 local id = createId(pick)
 if id then return findCreate(edits, id), nil end
 local row = findRow(model, pick)
 if row and row.origin == "home" and row.state == "ready" and row.fields then
  local form = edits.forms[row.name]
  if not form then
   form = formFrom(row)
   edits.forms[row.name] = form
  end
  return form, row
 end
 return nil, row
end

local function field(label: string, help: string?, body: {Node}): Node
 local children: {Node} = {leaf("setup-label", label)}
 if help then table.insert(children, leaf("setup-help", help)) end
 for _, node in body do table.insert(children, node) end
 return box("setup-field", children)
end

local function boxed(node: Node, bad: boolean): Node
 return box(if bad then "setup-box setup-box-bad" else "setup-box", {node})
end

local function tag(row: Row): {Node}
 local origin = ORIGIN_TAG[row.origin]
 local tags: {Node} = {leaf(origin[2], origin[1])}
 if row.state == "broken" then
  table.insert(tags, leaf("setup-tag setup-tag-bad", "Unavailable"))
 elseif row.hiddenBy or row.status.tone == "info" then
  table.insert(tags, leaf(if row.hiddenBy then "setup-tag setup-tag-builtin" else "setup-tag", row.status.text))
 end
 return tags
end

local function head(title: string, tags: {Node}, path: string, actions: {Node}): Node
 local line: {Node} = {leaf("setup-detail-title", title)}
 for _, node in tags do table.insert(line, node) end
 return box("setup-detail-head", {
  box("setup-detail-id", {box("setup-title-line", line), leaf("setup-muted setup-path", path)}),
  box("setup-head-actions", actions),
 })
end

local function readOnly(content: Content): Node
 local steps: {Node} = {}
 for index, step in content.steps do table.insert(steps, leaf("", index .. ". " .. step)) end
 if #steps == 0 then steps = {leaf("setup-muted", "No steps.")} end
 return box("setup-ro-pane", {
  field("Description", nil, {box("setup-ro", {leaf(if content.description then "" else "setup-muted", content.description or "None. Used only when named.")})}),
  field("Instructions", nil, {box("setup-ro", {leaf("", content.instructions)})}),
  field("Steps", nil, {box("setup-ro", steps)}),
 })
end

local function dimmed(row: Row?, node: Node): Node
 return box(if row and row.hiddenBy then "setup-dim" else "", {node})
end

local function overview(model: Model): {Node}
 local function line(origin: string, text: string): Node
  return box("setup-over-row", {leaf(ORIGIN_TAG[origin][2], ORIGIN_TAG[origin][1]), leaf("setup-muted", text)})
 end
 return {
  box("setup-detail-head", {box("setup-detail-id", {
   leaf("setup-detail-title", "Specialists"),
   leaf("setup-help", "A specialist tells Tandem how to approach one kind of task. Tandem picks one by its description, or you name it in chat."),
  })}),
  leaf("setup-label", "Where they come from"),
  box("setup-over-list", {
   line("repository", "in the repository at " .. model.teamFolder .. ", live once merged"),
   line("home", "only you, saved in " .. model.homeFolder),
   line("built-in", "ship with Tandem, read-only"),
  }),
  leaf("setup-label", "Same name in two places"),
  box("setup-over-row", {
   leaf(ORIGIN_TAG.repository[2], "Team"), leaf("setup-muted", "wins over"),
   leaf(ORIGIN_TAG.home[2], "Just me"), leaf("setup-muted", "wins over"), leaf(ORIGIN_TAG["built-in"][2], "Built-in"),
  }),
  leaf("setup-help", [[Tip: in chat, say "make me a specialist that writes release notes from merged PRs" and Tandem drafts it here.]]),
 }
end

local function nameNote(model: Model, name: string): string?
 if string.match(name, "^[a-z0-9][a-z0-9%-]*$") == nil then return nil end
 for _, row in model.rows do
  if row.name == name and row.state == "ready" then
   if row.origin == "repository" then return "Your team's " .. name .. " replaces this one in " .. model.project .. "." end
   if row.origin == "built-in" then return "Replaces the built-in " .. (if row.fields then row.fields.label else name) .. " for you." end
  end
 end
 return nil
end

local function steps(state: Session, form: Form, first: {[string]: string}): Node
 local rows: {Node} = {}
 local count = #form.steps
 for index, step in form.steps do
  local key = "sp-step-" .. index
  local tools: {Node} = {
   if index > 1 then leaf("setup-cmd-x", "↑", "sp-step-up=" .. index) else leaf("setup-cmd-x setup-cmd-off", "↑"),
   if index < count then leaf("setup-cmd-x", "↓", "sp-step-down=" .. index) else leaf("setup-cmd-x setup-cmd-off", "↓"),
   leaf("setup-cmd-x", "×", "sp-step-rm=" .. index),
  }
  table.insert(rows, box("setup-cmd", {leaf("setup-step-n", index .. "."), input(state, step, key, "Step"), box("setup-step-tools", tools)}))
  if first["step-" .. index] then table.insert(rows, leaf("setup-error setup-step-err", first["step-" .. index])) end
 end
 if count == 0 then table.insert(rows, leaf("setup-muted setup-cmd-empty", "No steps. The agent decides its own order.")) end
 table.insert(rows, leaf("setup-cmd-add", "+ Add step", "sp-step-add"))
 return box("setup-box", rows)
end

local function formBody(state: Session, model: Model, edits: Edits, form: Form): {Node}
 local first: {[string]: string} = {}
 local over = false
 for _, problem in M.problems(form, context(model, edits, form)) do
  if problem.field == "bytes" then over = true end
  if not first[problem.field] then first[problem.field] = problem.text end
 end
 local function below(key: string): {Node}
  local text = first[key]
  return if text then {leaf("setup-error setup-field-error", text)} else {}
 end
 local name = trim(form.name.text)
 local nameNodes: {Node}
 if form.id ~= nil and not form.locked then
  nameNodes = {boxed(input(state, form.name, "sp-name", "release-notes"), first.name ~= nil)}
 else
  nameNodes = {box("setup-locked", {leaf("setup-mono", name), leaf("setup-muted setup-locked-note", "locked")})}
 end
 for _, node in below("name") do table.insert(nameNodes, node) end
 local note = nameNote(model, name)
 if note and first.name == nil then table.insert(nameNodes, leaf("setup-info setup-field-note", note)) end
 local nameHelp = if form.id == nil then "Set when it was created. To rename, create a new specialist."
  elseif form.locked then "Same name as the built-in, so yours replaces it for you."
  else "Lowercase letters, numbers, and hyphens. It becomes the file name and can't change after you save."
 local label: {Node} = {boxed(input(state, form.label, "sp-label", "Release notes"), first.label ~= nil)}
 for _, node in below("label") do table.insert(label, node) end
 local description: {Node} = {boxed(input(state, form.description, "sp-desc", "When should Tandem pick this?"), first.description ~= nil)}
 for _, node in below("description") do table.insert(description, node) end
 local instructions: {Node} = {boxed(input(state, form.instructions, "sp-instr", "How should the agent approach this kind of task?"), first.instructions ~= nil)}
 for _, node in below("instructions") do table.insert(instructions, node) end
 local listed: {Node} = {steps(state, form, first), leaf(if over then "setup-warn setup-meter" else "setup-muted setup-meter", string.format("%d / %d bytes", bytes(form), model.limits.contentBytes))}
 return {
  field("Name", nameHelp, nameNodes),
  field("Label", "Shown in chat and on the board.", label),
  field("Description", "Tandem uses this to pick it; leave empty to use only when named.", description),
  field("Instructions", "What the agent should know and do. Markdown is fine. Shift+Enter starts a new line.", instructions),
  field("Steps", "Optional. The agent works through them in order.", listed),
 }
end

local function formPane(state: Session, model: Model, edits: Edits, form: Form, row: Row?): {Node}
 local marked = row ~= nil and edits.removes[row.name] ~= nil
 local name = trim(form.name.text)
 local title = trim(form.label.text)
 if title == "" then title = if row then row.name else "New specialist" end
 local tags: {Node} = if row then tag(row) else {leaf(ORIGIN_TAG.home[2], "Just me"), leaf("setup-tag setup-tag-builtin", "Not saved")}
 local actions: {Node} = {}
 if row and row.revision then
  table.insert(actions, if marked then leaf("setup-link", "Keep", "sp-keep") else leaf("setup-remove", "Remove", "sp-remove"))
 end
 local body: {Node} = {head(title, tags, model.homeFolder .. "/" .. (if name == "" then "<name>" else name) .. ".md", actions)}
 local content = contentOfRow(row)
 if marked and content then
  table.insert(body, leaf("setup-warn setup-notice", "Will be removed when you save."))
  table.insert(body, box("setup-dim", {readOnly(content)}))
 else
  for _, node in formBody(state, model, edits, form) do table.insert(body, node) end
 end
 return body
end

local function rowPane(model: Model, edits: Edits, row: Row): {Node}
 local actions: {Node} = {}
 local help: string? = nil
 local path = row.shownPath or ""
 if row.origin == "built-in" then
  path = "Built into Tandem"
  if homeRow(model, row.name) then
   table.insert(actions, leaf("setup-link", "Open yours", "sp-customize"))
   help = "You replaced this with your own " .. row.name .. ". Remove yours to use this one again."
  else
   table.insert(actions, components.button("Customize", "sp-customize", "accent"))
   help = "Built-ins are read-only. Customize copies it into an editable specialist with the same name, which replaces it for you."
  end
 elseif row.origin == "repository" then
  help = if row.state == "broken" then "Fix it in the repository." else "Shared through the repository. Changes go through a pull request."
 end
 local marked = row.origin == "home" and edits.removes[row.name] ~= nil
 if row.origin == "home" and row.state == "broken" then
  if row.revision then
   table.insert(actions, if marked then leaf("setup-link", "Keep", "sp-keep") else leaf("setup-remove", "Remove", "sp-remove"))
   help = if marked then "Will be removed when you save." else "Tandem skips this file until it is fixed or removed."
  else
   help = "Remove it yourself at " .. path .. "."
  end
 end
 local body: {Node} = {head(if row.fields then row.fields.label else row.name, tag(row), path, actions)}
 if row.state == "broken" then
  table.insert(body, box("setup-broken", {
   leaf("setup-error setup-strong", row.problem or ""),
   leaf("setup-help", help or ""),
  }))
 else
  if help then table.insert(body, leaf("setup-help setup-lead-help", help)) end
  table.insert(body, dimmed(row, readOnly(normal(row.fields :: Content))))
 end
 return body
end

local function item(state: Session, index: string, pick: string, label: string, summary: string?, status: string, tone: string, dim: boolean, draft: boolean): Node
 local action = "sp=" .. pick
 local class = "setup-item"
 if state.pick == pick then class ..= " setup-item-on" end
 if draft then class ..= " setup-item-draft" end
 if dim then class ..= " setup-item-dim" end
 local lines: {Node} = {leaf("setup-strong setup-item-label", label, action)}
 if summary then table.insert(lines, leaf("setup-muted setup-item-summary", summary, action)) end
 table.insert(lines, leaf("setup-item-status " .. tone, status, action))
 return box(class, lines, "sp-row-" .. index, action)
end

local function list(state: Session, model: Model, edits: Edits): Node
 local items: {Node} = {leaf("setup-add-entry", "+ New specialist", "sp-new")}
 local function group(title: string, origin: string)
  table.insert(items, leaf("setup-group setup-group-head", title))
  if origin == "home" then
   for _, form in edits.creates do
    local label = trim(form.label.text)
    table.insert(items, item(state, "new-" .. (form.id or 0), "new:" .. (form.id or 0), if label == "" then "New specialist" else label, nil, "Not saved yet", "setup-warn", false, true))
   end
  end
  for index, row in model.rows do
   if row.origin == origin then
    local label = if row.fields then row.fields.label else row.name
    local status, tone = row.status.text, TONE[row.status.tone]
    if origin == "home" and edits.removes[row.name] ~= nil then status, tone = "Will be removed", "setup-warn"
    elseif origin == "home" and edits.forms[row.name] and changed(model, row.name, edits.forms[row.name]) then status, tone = "Unsaved changes", "setup-warn" end
    table.insert(items, item(state, tostring(index), pickOf(row), label, if row.state == "ready" then row.summary else nil, status, tone, row.hiddenBy ~= nil, false))
   end
  end
 end
 group("TEAM · " .. model.teamFolder, "repository")
 group("JUST ME · " .. model.homeFolder, "home")
 group("BUILT-IN", "built-in")
 for _, problem in model.problems do table.insert(items, leaf("setup-muted setup-item-note", problem)) end
 return box("setup-split-list setup-spec-list", items)
end

function M.pane(state: Session, model: Model, edits: Edits): Node
 local pick = M.keep(model, edits, state.pick)
 state.pick = pick
 local body: {Node}
 if pick == nil then
  body = overview(model)
 else
  local form, row = formFor(model, edits, pick)
  if form then body = formPane(state, model, edits, form, row)
  elseif row then body = rowPane(model, edits, row)
  else body = overview(model) end
 end
 return box("setup-split", {list(state, model, edits), box("setup-detail", body)})
end

local function select(state: Session, pick: string)
 state.pick = pick
 reflow(state)
end

local function addCreate(state: Session, edits: Edits, make: (id: number) -> Form)
 local id = state.nextId
 state.nextId += 1
 table.insert(edits.creates, make(id))
 select(state, "new:" .. id)
end

local function blank(id: number): Form
 return {
  id = id, name = fields.create(), label = fields.create(), description = fields.create(), instructions = fields.create(nil, true),
  steps = {}, locked = false,
 }
end

local function moveStep(form: Form, from: number, to: number)
 local step = form.steps[from]
 if step == nil or to < 1 or to > #form.steps then return end
 table.remove(form.steps, from)
 table.insert(form.steps, to, step)
end

-- Handles `sp`, `sp-new`, `sp-customize`, `sp-remove`, `sp-keep` and the `sp-step-*` events.
function M.event(state: Session, model: Model, edits: Edits, name: string, value: string, cx: BlockCx)
 local pick = state.pick
 if name == "sp" then
  if M.keep(model, edits, value) then
   select(state, value)
   formFor(model, edits, value)
  end
  return
 end
 if name == "sp-new" then
  addCreate(state, edits, blank)
  focus(state, cx, "sp-name")
  return
 end
 local form: Form?, row: Row? = nil, nil
 if pick then form, row = formFor(model, edits, pick) end
 if name == "sp-customize" then
  local builtin = if pick then findRow(model, pick) else nil
  if builtin == nil or builtin.origin ~= "built-in" then return end
  local mine = homeRow(model, builtin.name)
  if mine then
   select(state, pickOf(mine))
   formFor(model, edits, pickOf(mine))
  elseif builtin.state == "ready" and builtin.fields then
   addCreate(state, edits, function(id) return formFromContent(builtin.name, builtin.fields :: Content, nil, id, true) end)
  end
 elseif name == "sp-remove" then
  if row and row.origin == "home" and row.revision then edits.removes[row.name] = row.revision end
  reflow(state)
 elseif name == "sp-keep" then
  if row then edits.removes[row.name] = nil end
  reflow(state)
 elseif form and (row == nil or edits.removes[row.name] == nil) then
  if name == "sp-step-add" then
   table.insert(form.steps, fields.create())
   reflow(state)
   focus(state, cx, "sp-step-" .. #form.steps)
  else
   local at = tonumber(value)
   if at == nil then return end
   if name == "sp-step-rm" then table.remove(form.steps, at)
   elseif name == "sp-step-up" then moveStep(form, at, at - 1)
   elseif name == "sp-step-down" then moveStep(form, at, at + 1) end
   reflow(state)
  end
 end
end

return M
