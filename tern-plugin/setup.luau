--!strict
-- First-run setup and Settings. The draft is transient block state: TypeScript validates the
-- answer and writes the files, so nothing here is persisted.
local ui = tern.ui
local fields = require("./text-field")
local components = require("./components")
local screen = require("./screen")
local rt = require("./rt")

type Choice = {model: string, thinking: string}
type Role = {
 id: string, name: string, what: string, color: string, hint: string, thinking: string,
 pick: Choice?, recommended: {model: Choice, reason: string}?,
}
type ModelInfo = {selector: string, harness: string, name: string, provider: string, thinking: {string}, priceLevel: string?}
type Harness = {id: string, name: string, unavailable: string?}
type RepoInfo = {
 name: string, path: string, shownPath: string, setUp: boolean, validationCommands: {string},
 setupCommands: {string}, suggestions: {string}, detectedFrom: string?, inspectionError: string?,
}
type View = {
 mode: string, models: {ModelInfo}, harnesses: {Harness}, roles: {Role},
 thinkingLevels: {{level: string, note: string}}, repos: {RepoInfo}, candidates: {RepoInfo}, selfImprovement: string,
}

type Repo = {
 path: string, name: string, shownPath: string, setUp: boolean, detectedFrom: string?, inspectionError: string?,
 validation: {fields.Field}, setup: {fields.Field}, suggestions: {string},
}
type Draft = {mode: string, models: {[string]: Choice}, repos: {Repo}, selfImprovement: string}
type State = {
 file: rt.Watch, origin: rt.Origin, draft: Draft?, saved: Draft?, savedSignature: string,
 step: string, open: string?, modelSearch: fields.Field, repoSearch: fields.Field, selected: number, adding: boolean,
 active: string, fields: {[string]: fields.Field}, order: {string}, done: boolean, notice: string?,
}

local SELF = {
 {id = "report", name = "Draft an issue", what = "Tandem writes up the bug. You decide whether to send it."},
 {id = "fix", name = "Fix it", what = "Tandem opens a task to fix the bug. It waits for your approval like any other task."},
 {id = "off", name = "Do nothing", what = "Tandem ignores bugs in its own code."},
}
local STEPS = {
 {id = "models", label = "Models"}, {id = "repos", label = "Repositories"},
 {id = "self", label = "Bug reports"}, {id = "review", label = "Review"},
}
local SHORTCUTS = {{"Board", "⌘⇧B"}, {"Pull requests", "⌘⇧P"}, {"Usage", "⌘⇧U"}, {"Settings", "⌘⇧,"}}

local function trim(text: string): string
 return string.match(text, "^%s*(.-)%s*$") or ""
end

-- Trimmed, non-blank, de-duplicated text in order: what an answer carries.
local function texts(list: {fields.Field}): {string}
 local out, seen = {}, {}
 for _, field in list do
  local text = trim(field.text)
  if text ~= "" and not seen[text] then
   seen[text] = true
   table.insert(out, text)
  end
 end
 return out
end

local function filled(list: {fields.Field}): number
 local count = 0
 for _, field in list do
  if trim(field.text) ~= "" then count += 1 end
 end
 return count
end

local function current(state: State): View?
 local model = state.file.model
 if model == nil then return nil end
 return model :: View
end

local function findModel(model: View, selector: string): ModelInfo?
 for _, info in model.models do
  if info.selector == selector then return info end
 end
 return nil
end

local function findRole(model: View, id: string?): Role?
 for _, role in model.roles do
  if role.id == id then return role end
 end
 return nil
end

local function describe(model: View, choice: Choice): string
 local info = findModel(model, choice.model)
 return (if info then info.name else choice.model) .. " · " .. choice.thinking
end

local function isRecommended(role: Role, choice: Choice?): boolean
 local recommended = role.recommended
 return recommended ~= nil and choice ~= nil and choice.model == recommended.model.model and choice.thinking == recommended.model.thinking
end

-- `all`: every role runs its recommendation. `offer`: some role with a recommendation does not.
local function recommendation(model: View, draft: Draft): (boolean, boolean)
 local all, offer = true, false
 for _, role in model.roles do
  if not isRecommended(role, draft.models[role.id]) then
   all = false
   if role.recommended then offer = true end
  end
 end
 return all, offer
end

-- The supported level nearest to `wanted` along `levels`; a lighter one wins a tie.
local function nearest(wanted: string, supported: {string}, levels: {{level: string, note: string}}): string
 local rank: {[string]: number} = {}
 for index, entry in levels do rank[entry.level] = index end
 local target = rank[wanted]
 if target == nil then return supported[1] or wanted end
 local best, bestRank, distance = wanted, 0, math.huge
 for _, level in supported do
  local at = rank[level]
  if at ~= nil then
   local gap = math.abs(at - target)
   if gap < distance or (gap == distance and at < bestRank) then best, bestRank, distance = level, at, gap end
  end
 end
 return best
end

local function repoFrom(info: RepoInfo): Repo
 local validation, setup = {}, {}
 for _, command in info.validationCommands do table.insert(validation, fields.create(command)) end
 for _, command in info.setupCommands do table.insert(setup, fields.create(command)) end
 return {
  path = info.path, name = info.name, shownPath = info.shownPath, setUp = info.setUp,
  detectedFrom = info.detectedFrom, inspectionError = info.inspectionError,
  validation = validation, setup = setup, suggestions = info.suggestions,
 }
end

local function buildDraft(model: View): Draft
 local models: {[string]: Choice} = {}
 for _, role in model.roles do
  local choice = role.pick or (if role.recommended then role.recommended.model else nil)
  if choice then models[role.id] = {model = choice.model, thinking = choice.thinking} end
 end
 local repos = {}
 for _, info in model.repos do table.insert(repos, repoFrom(info)) end
 return {mode = model.mode, models = models, repos = repos, selfImprovement = model.selfImprovement}
end

local function copyFields(list: {fields.Field}): {fields.Field}
 local out = {}
 for _, field in list do table.insert(out, fields.create(field.text)) end
 return out
end

local function copyDraft(draft: Draft): Draft
 local models: {[string]: Choice} = {}
 for id, choice in draft.models do models[id] = {model = choice.model, thinking = choice.thinking} end
 local repos = {}
 for _, repo in draft.repos do
  table.insert(repos, {
   path = repo.path, name = repo.name, shownPath = repo.shownPath, setUp = repo.setUp,
   detectedFrom = repo.detectedFrom, inspectionError = repo.inspectionError,
   validation = copyFields(repo.validation), setup = copyFields(repo.setup), suggestions = repo.suggestions,
  })
 end
 return {mode = draft.mode, models = models, repos = repos, selfImprovement = draft.selfImprovement}
end

-- What the answer would say, as one string: equal strings mean equal answers.
local function signature(model: View, draft: Draft): string
 local parts: {string} = {draft.selfImprovement}
 for _, role in model.roles do
  local choice = draft.models[role.id]
  table.insert(parts, if choice then choice.model .. " " .. choice.thinking else "")
 end
 for _, repo in draft.repos do
  table.insert(parts, repo.path)
  table.insert(parts, table.concat(texts(repo.validation), "\30"))
  table.insert(parts, table.concat(texts(repo.setup), "\30"))
 end
 return table.concat(parts, "\31")
end

local function answer(model: View, draft: Draft): {[string]: unknown}
 local models = {}
 for _, role in model.roles do
  local choice = draft.models[role.id]
  if choice then models[role.id] = {model = choice.model, thinking = choice.thinking} end
 end
 local repositories = {}
 for _, repo in draft.repos do
  table.insert(repositories, {
   path = repo.path, validationCommands = tern.json.array(texts(repo.validation)), setupCommands = tern.json.array(texts(repo.setup)),
  })
 end
 return {tandemSetup = 1, mode = draft.mode, models = models, repositories = tern.json.array(repositories), selfImprovement = draft.selfImprovement}
end

-- Why Start/Save is unavailable, in the words the bottom bar shows.
local function blocker(model: View, draft: Draft): string?
 for _, role in model.roles do
  if not draft.models[role.id] then return "Choose a model for " .. role.name .. "." end
 end
 if draft.mode == "setup" and #draft.repos == 0 then return "Add a repository to start." end
 local names = {}
 for _, repo in draft.repos do
  if filled(repo.validation) == 0 then table.insert(names, repo.name) end
 end
 if #names > 0 then return table.concat(names, " and ") .. (if #names > 1 then " need" else " needs") .. " a validation command." end
 return nil
end

local function sync(state: State)
 if state.draft ~= nil or state.file.status ~= "ready" then return end
 local model = state.file.model :: View
 local draft = buildDraft(model)
 state.draft, state.saved, state.savedSignature = draft, copyDraft(draft), signature(model, draft)
 state.step = if model.mode == "setup" then "summary" else "models"
end

-- Field keys are the one way a key press finds its field; clearing them on any layout change keeps
-- a stale index from reaching another row.
local function reflow(state: State)
 state.active, state.fields, state.order = "", {}, {}
end

local function clearField(field: fields.Field)
 field.text, field.cursor, field.anchor = "", 0, 0
end

local function send(state: State, model: View, draft: Draft, cx: BlockCx)
 if state.origin.busy or state.file.status ~= "ready" or blocker(model, draft) ~= nil then return end
 local sent = copyDraft(draft)
 state.notice = nil
 rt.act(cx, state.origin, {verb = "setup-save", answer = answer(model, draft)}, function(outcome)
  if outcome ~= nil and outcome.status == "done" then
   -- Saved repositories are set up now, so Settings no longer offers to remove them.
   local paths: {[string]: boolean} = {}
   for _, repo in sent.repos do repo.setUp, paths[repo.path] = true, true end
   local live = state.draft
   if live then
    for _, repo in live.repos do
     if paths[repo.path] then repo.setUp = true end
    end
   end
   state.saved, state.savedSignature = sent, signature(model, sent)
   if sent.mode == "setup" then state.done = true end
  elseif outcome ~= nil and outcome.status == "kept" and outcome.notice then
   state.notice = outcome.notice.text
  end
  pcall(function() cx:render() end)
 end, rt.SETUP)
end

local function leaf(class: string, text: string, action: string?): Node
 return ui.el("div", {class = class, text = text, actions = if action then {click = action} else nil})
end

local function box(class: string, children: {Node}, key: string?, action: string?): Node
 return ui.el("div", {class = class, key = key, actions = if action then {click = action} else nil}, children)
end

local function mark(class: string, action: string?): Node
 return ui.el("span", {class = class, actions = if action then {click = action} else nil})
end

local function input(state: State, field: fields.Field, key: string, placeholder: string): Node
 state.fields[key] = field
 table.insert(state.order, key)
 return fields.node(field, key, placeholder)
end

local function card(title: string, body: {Node}, tag: string?, action: Node?): Node
 local heading: {Node} = {leaf("setup-card-title", title)}
 if tag then table.insert(heading, leaf("setup-tag", tag)) end
 local head: {Node} = {box("setup-card-heading", heading)}
 if action then table.insert(head, action) end
 table.insert(body, 1, box("setup-card-head", head))
 return box("setup-card", body)
end

local function recapRow(label: Node, value: Node): Node
 return box("setup-recap-row", {box("setup-recap-key", {label}), box("setup-recap-value", {value})})
end

local function dot(role: Role): Node
 local token = string.gsub(role.color, "^%-+", "")
 return mark("setup-dot setup-dot-" .. token)
end

local function modelRecap(model: View, draft: Draft): Node
 local rows: {Node} = {}
 for _, role in model.roles do
  local choice = draft.models[role.id]
  table.insert(rows, recapRow(
   box("setup-recap-role", {dot(role), leaf("setup-muted", role.name)}),
   leaf("", if choice then describe(model, choice) else "No model")
  ))
 end
 return box("setup-recap", rows)
end

local function repoRecap(draft: Draft, detailed: boolean): Node
 if #draft.repos == 0 then return leaf("setup-muted", "No repositories yet. Add the ones Tandem should work in.") end
 local rows: {Node} = {}
 for _, repo in draft.repos do
  local value: Node
  if detailed then
   local validation, setup = texts(repo.validation), texts(repo.setup)
   value = box("setup-recap-lines", {
    leaf("setup-muted", "Validation: " .. (if #validation > 0 then table.concat(validation, ", ") else "none")),
    leaf("setup-muted", "Setup: " .. (if #setup > 0 then table.concat(setup, ", ") else "none")),
   })
  elseif filled(repo.validation) > 0 then
   value = leaf("setup-muted", "Validates with " .. table.concat(texts(repo.validation), ", "))
  else
   value = leaf("setup-warn", "Needs a validation command")
  end
  table.insert(rows, recapRow(leaf("setup-strong", repo.name), value))
 end
 return box("setup-recap", rows)
end

local function selfName(draft: Draft): string
 for _, option in SELF do
  if option.id == draft.selfImprovement then return option.name end
 end
 return draft.selfImprovement
end

local function picker(state: State, model: View, draft: Draft, role: Role): Node
 local nodes: {Node} = {}
 local choice = draft.models[role.id]
 local recommended = role.recommended
 local recommendedAt: number? = nil
 if recommended then
  local info = findModel(model, recommended.model.model)
  table.insert(nodes, box("setup-why", {ui.text({
   ui.span("Recommended: " .. (if info then info.name else recommended.model.model) .. " on " .. recommended.model.thinking .. ".", "strong"),
   ui.span(" " .. recommended.reason, "muted"),
  })}))
  for index, candidate in model.models do
   if candidate.selector == recommended.model.model then recommendedAt = index end
  end
 end
 table.insert(nodes, input(state, state.modelSearch, "search-models", "Search models"))
 local query = string.lower(state.modelSearch.text)
 local function row(index: number, info: ModelInfo, tagged: boolean): Node
  local action = "model=" .. index
  local name: {Node} = {leaf("setup-model-name", info.name, action)}
  if tagged then table.insert(name, leaf("setup-rec", "Recommended")) end
  local selected = choice ~= nil and choice.model == info.selector
  return box(if selected then "setup-model setup-model-on" else "setup-model", {
   box("setup-model-left", name),
   leaf("setup-muted", info.provider .. (if info.priceLevel then " · " .. info.priceLevel else ""), action),
  }, "model-" .. index, action)
 end
 local function matches(info: ModelInfo): boolean
  local haystack = string.lower(info.name .. " " .. info.provider .. " " .. info.selector .. " " .. (info.priceLevel or ""))
  return query == "" or string.find(haystack, query, 1, true) ~= nil
 end
 local shown = 0
 if recommendedAt then
  local info = model.models[recommendedAt]
  if matches(info) then
   table.insert(nodes, row(recommendedAt, info, true))
   shown += 1
  end
 end
 for _, harness in model.harnesses do
  local group: {Node} = {}
  for index, info in model.models do
   if info.harness == harness.id and index ~= recommendedAt and matches(info) then table.insert(group, row(index, info, false)) end
  end
  if harness.unavailable then
   table.insert(nodes, leaf("setup-group", harness.name))
   table.insert(nodes, leaf("setup-muted setup-group-note", harness.unavailable))
  elseif #group > 0 then
   table.insert(nodes, leaf("setup-group", harness.name))
   for _, node in group do table.insert(nodes, node) end
   shown += #group
  end
 end
 if shown == 0 then table.insert(nodes, leaf("setup-muted setup-empty", "No models match.")) end
 local info = if choice then findModel(model, choice.model) else nil
 if choice and info then
  local levels: {Node} = {leaf("setup-muted", "Thinking")}
  for _, level in info.thinking do
   table.insert(levels, components.button(level, "think=" .. level, if level == choice.thinking then "accent" else "muted"))
  end
  table.insert(nodes, box("setup-thinking", levels))
 end
 return box("setup-picker", nodes)
end

local function modelsCard(state: State, model: View, draft: Draft): Node
 local rows: {Node} = {}
 for _, role in model.roles do
  local choice = draft.models[role.id]
  local open = state.open == role.id
  local label = (if choice then describe(model, choice) else "Choose a model") .. " ▾"
  local parts: {Node} = {box("setup-role-line", {
   dot(role),
   box("setup-role-text", {
    ui.text({ui.span(role.name, "strong"), ui.span(" · " .. role.what, "muted")}),
    leaf("setup-hint", "Recommended: " .. role.hint),
   }),
   components.button(label, "pick=" .. role.id, if open then "accent" else "muted"),
  })}
  if open then table.insert(parts, picker(state, model, draft, role)) end
  table.insert(rows, box("setup-role", parts, "role-" .. role.id))
 end
 local _, offer = recommendation(model, draft)
 return card("Models", rows, nil, if offer then leaf("setup-link", "Use recommended", "use-recommended") else nil)
end

local function commandList(state: State, index: number, repo: Repo, kind: string, add: string, empty: string?): Node
 local list = if kind == "validation" then repo.validation else repo.setup
 local rows: {Node} = {}
 for row, field in list do
  local key = string.format("cmd-%s-%d-%d", kind, index, row)
  table.insert(rows, box("setup-cmd", {input(state, field, key, "Command"), leaf("setup-cmd-x", "×", "rm=" .. kind .. "-" .. row)}, "row-" .. key))
 end
 if #list == 0 and empty then table.insert(rows, leaf("setup-warn setup-cmd-empty", empty)) end
 table.insert(rows, leaf("setup-cmd-add", add, "cmd-add=" .. kind))
 return box("setup-box", rows)
end

local function isChosen(draft: Draft, path: string): boolean
 for _, repo in draft.repos do
  if repo.path == path then return true end
 end
 return false
end

local function addPane(state: State, model: View, draft: Draft): {Node}
 local query = string.lower(state.repoSearch.text)
 local rows: {Node} = {}
 for index, candidate in model.candidates do
  if not isChosen(draft, candidate.path) and (query == "" or string.find(string.lower(candidate.name .. " " .. candidate.path), query, 1, true) ~= nil) then
   local action = "add=" .. index
   table.insert(rows, box("setup-addrow", {
    leaf("setup-strong", candidate.name, action), leaf("setup-muted setup-path", candidate.shownPath, action),
    components.button("Add", action),
   }, "candidate-" .. index, action))
  end
 end
 if #rows == 0 then table.insert(rows, leaf("setup-muted setup-empty", "No other repositories match.")) end
 local body: {Node} = {
  box("setup-detail-head", {box("setup-detail-id", {
   leaf("setup-detail-title", "Add a repository"), leaf("setup-help", "Tandem works only in repositories you add here."),
  })}),
  input(state, state.repoSearch, "search-repos", "Search repositories by name"),
 }
 for _, row in rows do table.insert(body, row) end
 return body
end

local function repoPane(state: State, index: number, repo: Repo): {Node}
 local head: {Node} = {box("setup-detail-id", {leaf("setup-detail-title", repo.name), leaf("setup-muted setup-path", repo.shownPath)})}
 if not repo.setUp then table.insert(head, leaf("setup-remove", "Remove", "remove")) end
 local present: {[string]: boolean} = {}
 for _, text in texts(repo.validation) do present[text] = true end
 local chips: {Node} = {}
 for at, suggestion in repo.suggestions do
  if not present[trim(suggestion)] then table.insert(chips, leaf("setup-chip", "+ " .. suggestion, "suggest=" .. at)) end
 end
 local validation: {Node} = {
  leaf("setup-label", "Validation commands"),
  leaf("setup-help", "Tandem runs these to test every change. A change is ready only when all of them pass."),
  commandList(state, index, repo, "validation", "+ Add validation command", "Required. Without one, no change in this repository can be marked ready."),
 }
 if #chips > 0 then
  table.insert(chips, 1, leaf("setup-muted", "Suggested from package.json"))
  table.insert(validation, box("setup-suggest", chips))
 end
 local body: {Node} = {
  box("setup-detail-head", head),
  box("setup-field", validation),
  box("setup-field", {
   leaf("setup-label", "Setup commands"),
   leaf("setup-help", "Run before Tandem starts work in a task's worktree. Usually installs dependencies."),
   commandList(state, index, repo, "setup", "+ Add setup command", nil),
  }),
 }
 if repo.detectedFrom then table.insert(body, leaf("setup-muted setup-source", "Detected from " .. repo.detectedFrom)) end
 if repo.inspectionError then table.insert(body, leaf("setup-warn setup-source", repo.inspectionError)) end
 return body
end

local function reposPane(state: State, model: View, draft: Draft): Node
 local adding = state.adding or #draft.repos == 0
 state.selected = math.clamp(state.selected, 1, math.max(1, #draft.repos))
 local items: {Node} = {}
 for index, repo in draft.repos do
  local count = filled(repo.validation)
  local action = "repo=" .. index
  local status = if count == 0 then leaf("setup-item-status setup-warn", "Needs a validation command", action)
   else leaf("setup-item-status setup-muted", count .. (if count == 1 then " validation command" else " validation commands"), action)
  local on = not adding and state.selected == index
  table.insert(items, box(if on then "setup-item setup-item-on" else "setup-item", {leaf("setup-strong", repo.name, action), status}, "repo-" .. index, action))
 end
 table.insert(items, leaf(if adding then "setup-add-entry setup-item-on" else "setup-add-entry", "+ Add repository", "adding"))
 local repo = draft.repos[state.selected]
 local detail = if adding or repo == nil then addPane(state, model, draft) else repoPane(state, state.selected, repo)
 return box("setup-split", {box("setup-split-list", items), box("setup-detail", detail)})
end

local function selfCard(draft: Draft): Node
 local options: {Node} = {}
 for _, option in SELF do
  local action = "self=" .. option.id
  local on = draft.selfImprovement == option.id
  table.insert(options, box(if on then "setup-option setup-option-on" else "setup-option", {
   mark(if on then "setup-radio setup-radio-on" else "setup-radio", action),
   box("setup-option-text", {leaf("setup-strong", option.name, action), leaf("setup-muted", option.what, action)}),
  }, "self-" .. option.id, action))
 end
 return card("When Tandem finds a bug in itself", options)
end

local function disabled(label: string): Node
 return ui.node("badge", {text = label, tone = "muted"})
end

local function sendButton(state: State, label: string, enabled: boolean): Node
 if state.origin.busy then return disabled("Saving…") end
 if enabled then return components.button(label, "send", "accent") end
 return disabled(label)
end

local function heading(title: string, lead: string): {Node}
 return {leaf("setup-title", title), leaf("setup-lead", lead)}
end

local function page(children: {Node}, wide: boolean): Node
 return box(if wide then "setup-page setup-wide" else "setup-page", children)
end

local function tabs(labels: {{id: string, label: string}}, active: string, numbered: boolean): Node
 local activeAt = 0
 for index, entry in labels do
  if entry.id == active then activeAt = index end
 end
 local nodes: {Node} = {}
 for index, entry in labels do
  local tone = if entry.id == active then "accent" elseif index < activeAt then "success" else "muted"
  table.insert(nodes, components.button(if numbered then index .. ". " .. entry.label else entry.label, "go=" .. entry.id, tone))
 end
 return box("setup-stepper", nodes)
end

local function bar(children: {Node}): Node
 return ui.col({box("setup-bar", children)})
end

local function spacer(): Node
 return box("setup-spacer", {})
end

local function body(state: State, model: View, draft: Draft, id: string): Node
 if id == "models" then return modelsCard(state, model, draft) end
 if id == "repos" then return reposPane(state, model, draft) end
 return selfCard(draft)
end

local function doneView(): BlockView
 local rows: {Node} = {}
 for _, shortcut in SHORTCUTS do table.insert(rows, recapRow(leaf("", shortcut[1]), leaf("setup-muted", shortcut[2]))) end
 local children = heading("You're all set", "Each repository has its own chat in the sidebar. Open one and describe the change you want.")
 table.insert(children, card("Shortcuts", {box("setup-recap", rows), leaf("setup-muted setup-footnote", [[Every Tandem action is also in Tern's command palette. Type "Tandem".]])}))
 table.insert(children, box("setup-actions", {components.button("Close", "close", "accent")}))
 return {main = ui.col({page(children, false)})}
end

local function summaryView(state: State, model: View, draft: Draft, reason: string?): BlockView
 local all, offer = recommendation(model, draft)
 local modelBody: {Node} = {modelRecap(model, draft)}
 if offer then table.insert(modelBody, leaf("setup-link setup-use", "Use recommended models", "use-recommended")) end
 local children = heading("Set up Tandem", "These settings are ready to use. You can change any of them later.")
 screen.status(children, state.file.status)
 if state.notice then table.insert(children, leaf("setup-warn", state.notice)) end
 table.insert(children, card("Models", modelBody, if all then "Recommended" else nil, leaf("setup-link", "Change", "go=models")))
 table.insert(children, card("Repositories", {repoRecap(draft, false)}, nil, leaf("setup-link", "Change", "go=repos")))
 table.insert(children, card("When Tandem finds a bug in itself", {leaf("", selfName(draft))}, nil, leaf("setup-link", "Change", "go=self")))
 local ready = state.file.status == "ready" and reason == nil
 local actions: {Node} = {sendButton(state, "Start", ready), components.button("Customize", "go=models")}
 if reason then table.insert(actions, leaf("setup-warn setup-note", reason)) end
 return {main = ui.col({page(children, false)}), dock = bar(actions)}
end

local function stepView(state: State, model: View, draft: Draft, reason: string?): BlockView
 local children: {Node} = {leaf("setup-title", "Set up Tandem")}
 table.insert(children, tabs(STEPS, state.step, true))
 screen.status(children, state.file.status)
 if state.notice then table.insert(children, leaf("setup-warn", state.notice)) end
 if state.step == "review" then
  table.insert(children, card("Models", {modelRecap(model, draft)}))
  table.insert(children, card("Repositories", {repoRecap(draft, true)}))
  table.insert(children, card("When Tandem finds a bug in itself", {leaf("", selfName(draft))}))
 else
  table.insert(children, body(state, model, draft, state.step))
 end
 local at = 1
 for index, entry in STEPS do
  if entry.id == state.step then at = index end
 end
 local back = components.button("Back", "go=" .. (if at > 1 then STEPS[at - 1].id else "summary"))
 local actions: {Node} = {back, spacer()}
 if state.step == "review" then
  if reason then table.insert(actions, leaf("setup-warn setup-note", reason)) end
  table.insert(actions, sendButton(state, "Start", state.file.status == "ready" and reason == nil))
 else
  table.insert(actions, components.button("Continue", "go=" .. STEPS[at + 1].id, "accent"))
 end
 return {main = ui.col({page(children, false)}), dock = bar(actions)}
end

local function settingsView(state: State, model: View, draft: Draft, reason: string?): BlockView
 local children = heading("Settings", "Changes apply to new tasks. Tasks already running keep the settings they started with.")
 table.insert(children, tabs({STEPS[1], STEPS[2], STEPS[3]}, state.step, false))
 screen.status(children, state.file.status)
 if state.notice then table.insert(children, leaf("setup-warn", state.notice)) end
 table.insert(children, body(state, model, draft, state.step))
 local dirty = signature(model, draft) ~= state.savedSignature
 local actions: {Node} = {leaf("setup-muted", if dirty then "Unsaved changes" else "All changes saved"), spacer()}
 if dirty then
  if reason then table.insert(actions, leaf("setup-warn setup-note", reason)) end
  table.insert(actions, components.button("Discard", "discard"))
  table.insert(actions, sendButton(state, "Save changes", state.file.status == "ready" and reason == nil))
 end
 return {main = ui.col({page(children, true)}), dock = bar(actions)}
end

local function setStep(state: State, draft: Draft, id: string)
 local known = id == "models" or id == "repos" or id == "self" or (draft.mode == "setup" and (id == "summary" or id == "review"))
 if not known then return end
 state.step, state.open, state.adding = id, nil, false
 reflow(state)
end

local function choose(state: State, model: View, draft: Draft, index: number?)
 local role = findRole(model, state.open)
 local info = if index then model.models[index] else nil
 if not role or not info then return end
 local choice = draft.models[role.id]
 local wanted = if choice then choice.thinking else role.thinking
 draft.models[role.id] = {
  model = info.selector,
  thinking = if table.find(info.thinking, wanted) then wanted else nearest(role.thinking, info.thinking, model.thinkingLevels),
 }
 state.open = nil
 reflow(state)
end

local function think(state: State, model: View, draft: Draft, level: string)
 local role = findRole(model, state.open)
 local choice = if role then draft.models[role.id] else nil
 local info = if choice then findModel(model, choice.model) else nil
 if choice and info and table.find(info.thinking, level) then choice.thinking = level end
end

local function addRepo(state: State, model: View, draft: Draft, index: number?)
 local candidate = if index then model.candidates[index] else nil
 if not candidate or isChosen(draft, candidate.path) then return end
 table.insert(draft.repos, repoFrom(candidate))
 state.selected, state.adding = #draft.repos, false
 clearField(state.repoSearch)
 reflow(state)
end

local function editCommands(state: State, draft: Draft, cx: BlockCx, name: string, value: string)
 local repo = draft.repos[state.selected]
 if not repo then return end
 if name == "cmd-add" then
  if value ~= "validation" and value ~= "setup" then return end
  local list = if value == "validation" then repo.validation else repo.setup
  local field = fields.create()
  table.insert(list, field)
  local key = string.format("cmd-%s-%d-%d", value, state.selected, #list)
  state.fields[key], state.active = field, key
  cx:render()
  pcall(function() cx:frame({{"focus", "main." .. key}}) end)
 elseif name == "rm" then
  local kind, row = string.match(value, "^(%a+)%-(%d+)$")
  local list = if kind == "validation" then repo.validation elseif kind == "setup" then repo.setup else nil
  local at = tonumber(row)
  if list and at then table.remove(list, at) end
  reflow(state)
 elseif name == "suggest" then
  local suggestion = repo.suggestions[tonumber(value) or 0]
  if suggestion then table.insert(repo.validation, fields.create(suggestion)) end
  reflow(state)
 end
end

local block: BlockDef<State> = {
 init = function(cx, args)
  local state: State = {
   file = rt.watch(cx, args[1] or "", "setup"), origin = rt.origin(args), savedSignature = "",
   step = "summary", modelSearch = fields.create(), repoSearch = fields.create(), selected = 1, adding = false,
   active = "", fields = {}, order = {}, done = false,
  }
  sync(state)
  return state
 end,
 title = function(state)
  local draft = state.draft
  if not draft then return "Tandem setup" end
  return if draft.mode == "settings" then "Settings" else "Set up Tandem"
 end,
 view = function(state)
  sync(state)
  state.fields, state.order = {}, {}
  local model, draft = current(state), state.draft
  if not model or not draft then
   local children = {leaf("setup-title", "Tandem setup")}
   screen.status(children, state.file.status)
   return {main = ui.col({page(children, false)})}
  end
  if state.done then return doneView() end
  local reason = blocker(model, draft)
  if draft.mode == "settings" then return settingsView(state, model, draft, reason) end
  if state.step == "summary" then return summaryView(state, model, draft, reason) end
  return stepView(state, model, draft, reason)
 end,
 key = function(state, key, cx)
  local model, draft = current(state), state.draft
  if not model or not draft or state.done then return false end
  local field = state.fields[state.active]
  if field then
   local outcome = fields.key(field, key)
   if outcome == "changed" then return true end
   if outcome == "next" then
    local at = table.find(state.order, state.active) or 0
    local target = if #state.order > 0 then state.order[at % #state.order + 1] else nil
    if not target then return false end
    state.active = target
    pcall(function() cx:frame({{"focus", "main." .. target}}) end)
    return true
   end
   if outcome == "cancel" then
    if state.active == "search-models" then
     clearField(state.modelSearch)
     state.open = nil
    elseif state.active == "search-repos" then
     clearField(state.repoSearch)
     if #draft.repos > 0 then state.adding = false end
    else
     return false
    end
    reflow(state)
    return true
   end
   return false
  end
  if key.name == "enter" and draft.mode == "setup" and state.step == "summary" and state.file.status == "ready" and not state.origin.busy and blocker(model, draft) == nil then
   send(state, model, draft, cx)
   return true
  end
  return false
 end,
 event = function(state, ev, cx)
  if ev.ev == "focus" then
   local key = if ev.id then string.match(ev.id, "[^%.]+$") else nil
   if key and state.fields[key] then state.active = key end
   return
  end
  if ev.ev ~= "action" then return end
  local name: string = ev.act
  local value: string = ev.value or ""
  if name == "close" then
   if state.done then cx:exit(0) end
   return
  end
  local model, draft = current(state), state.draft
  if not model or not draft or state.done then return end
  if name == "send" then send(state, model, draft, cx)
  elseif name == "go" then setStep(state, draft, value)
  elseif name == "use-recommended" then
   for _, role in model.roles do
    local recommended = role.recommended
    if recommended then draft.models[role.id] = {model = recommended.model.model, thinking = recommended.model.thinking} end
   end
   state.open = nil
   reflow(state)
  elseif name == "pick" then
   state.open = if state.open == value or not findRole(model, value) then nil else value
   clearField(state.modelSearch)
   reflow(state)
  elseif name == "model" then choose(state, model, draft, tonumber(value))
  elseif name == "think" then think(state, model, draft, value)
  elseif name == "repo" then
   local at = tonumber(value)
   if at and draft.repos[at] then state.selected, state.adding = at, false end
   reflow(state)
  elseif name == "adding" then
   state.adding = true
   clearField(state.repoSearch)
   reflow(state)
  elseif name == "add" then addRepo(state, model, draft, tonumber(value))
  elseif name == "remove" then
   local repo = draft.repos[state.selected]
   if repo and not repo.setUp then
    table.remove(draft.repos, state.selected)
    state.selected, state.adding = math.max(1, math.min(state.selected, #draft.repos)), false
   end
   reflow(state)
  elseif name == "cmd-add" or name == "rm" or name == "suggest" then editCommands(state, draft, cx, name, value)
  elseif name == "self" then
   for _, option in SELF do
    if option.id == value then draft.selfImprovement = value end
   end
  elseif name == "discard" then
   local saved = state.saved
   if saved then state.draft = copyDraft(saved) end
   state.open, state.adding, state.selected = nil, false, 1
   reflow(state)
  end
  cx:render()
 end,
 save = function() return {} end,
}
return block
