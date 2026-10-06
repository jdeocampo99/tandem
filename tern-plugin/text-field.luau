--!strict
local M = {}
export type Field = { text: string, cursor: number, anchor: number, multiline: boolean }
export type Outcome = "changed" | "submit" | "cancel" | "next" | "ignored"
function M.create(text: string?, multiline: boolean?): Field
 local value = text or ""
 local length = utf8.len(value) or 0
 return { text = value, cursor = length, anchor = length, multiline = multiline or false }
end
local function byte(text: string, position: number): number
 return utf8.offset(text, position + 1) or (#text + 1)
end
local function replace(field: Field, text: string, from: number, to: number)
 field.text = string.sub(field.text, 1, byte(field.text, from) - 1) .. text .. string.sub(field.text, byte(field.text, to))
 field.cursor = from + (utf8.len(text) or 0)
 field.anchor = field.cursor
end
function M.key(field: Field, key: Key): Outcome
 local length = utf8.len(field.text) or 0
 local from, to = math.min(field.cursor, field.anchor), math.max(field.cursor, field.anchor)
 if key.name == "escape" then return "cancel" end
 if key.name == "tab" then return "next" end
 if (key.meta or key.ctrl) and key.name == "a" then field.anchor = 0; field.cursor = length; return "changed" end
 if key.name == "left" or key.name == "right" or key.name == "home" or key.name == "end" then
  if key.name == "home" then field.cursor = 0
  elseif key.name == "end" then field.cursor = length
  elseif not key.shift and from ~= to then field.cursor = if key.name == "left" then from else to
  else field.cursor = math.clamp(field.cursor + (if key.name == "left" then -1 else 1), 0, length) end
  if not key.shift then field.anchor = field.cursor end
  return "changed"
 end
 if key.name == "backspace" or key.name == "delete" then
  if from == to then
   if key.name == "backspace" then from = math.max(0, from - 1) else to = math.min(length, to + 1) end
  end
  replace(field, "", from, to); return "changed"
 end
 local text = key.text or (if key.name == "space" then " " else nil)
 if key.name == "enter" then
  if not (field.multiline and key.shift) then return "submit" end
  text = "\n"
 end
 if text == nil or ((key.ctrl or key.meta or key.alt) and key.name ~= "paste") then return "ignored" end
 if not field.multiline then text = string.gsub(text, "[\r\n]+", " ") end
 replace(field, text, from, to); return "changed"
end
function M.node(field: Field, key: string, placeholder: string?): Node
 local function units(position: number): number
  local count = 0
  for _, code in utf8.codes(string.sub(field.text, 1, byte(field.text, position) - 1)) do
   count += if code >= 0x10000 then 2 else 1
  end
  return count
 end
 return tern.ui.node(if field.multiline then "editor" else "input", {
  key = key, text = field.text, cursor = units(field.cursor), anchor = units(field.anchor), placeholder = placeholder,
 })
end
return M
