--!nocheck
-- The JSON codec of the recording Tern stand-ins: `tern.json` in host.luau and the render test.
-- Each stand-in prepends this file, so `json` is a local of the script it joins.

local json = {}
local arrays = setmetatable({}, { __mode = "k" })

local function decodeError(text, at, message)
	error(string.format("JSON %s at byte %d near %q", message, at, string.sub(text, at, at + 20)), 0)
end

function json.decode(text)
	if type(text) ~= "string" then error("JSON input must be a string", 0) end
	local at = 1
	local function space()
		at = string.find(text, "[^ \t\r\n]", at) or (#text + 1)
	end
	local value
	local function str()
		at += 1
		local parts = {}
		while true do
			local stop = string.find(text, '["\\]', at)
			if not stop then decodeError(text, at, "unterminated string") end
			table.insert(parts, string.sub(text, at, stop - 1))
			at = stop
			if string.sub(text, at, at) == '"' then at += 1; break end
			local escape = string.sub(text, at + 1, at + 1)
			local simple = ({ ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" })[escape]
			if simple then
				table.insert(parts, simple); at += 2
			elseif escape == "u" then
				local code = tonumber(string.sub(text, at + 2, at + 5), 16)
				if not code then decodeError(text, at, "bad unicode escape") end
				at += 6
				if code >= 0xD800 and code <= 0xDBFF and string.sub(text, at, at + 1) == "\\u" then
					local low = tonumber(string.sub(text, at + 2, at + 5), 16)
					if low and low >= 0xDC00 and low <= 0xDFFF then
						code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00); at += 6
					end
				end
				table.insert(parts, utf8.char(code))
			else
				decodeError(text, at, "bad escape")
			end
		end
		return table.concat(parts)
	end
	function value()
		space()
		local char = string.sub(text, at, at)
		if char == "{" then
			at += 1
			local result = {}
			space()
			if string.sub(text, at, at) == "}" then at += 1; return result end
			while true do
				space()
				if string.sub(text, at, at) ~= '"' then decodeError(text, at, "expected key") end
				local key = str()
				space()
				if string.sub(text, at, at) ~= ":" then decodeError(text, at, "expected colon") end
				at += 1
				result[key] = value()
				space()
				local next = string.sub(text, at, at)
				at += 1
				if next == "}" then return result end
				if next ~= "," then decodeError(text, at - 1, "expected comma") end
			end
		elseif char == "[" then
			at += 1
			local result = {}
			arrays[result] = true
			space()
			if string.sub(text, at, at) == "]" then at += 1; return result end
			local index = 0
			while true do
				index += 1
				result[index] = value()
				space()
				local next = string.sub(text, at, at)
				at += 1
				if next == "]" then return result end
				if next ~= "," then decodeError(text, at - 1, "expected comma") end
			end
		elseif char == '"' then
			return str()
		elseif string.sub(text, at, at + 3) == "true" then at += 4; return true
		elseif string.sub(text, at, at + 4) == "false" then at += 5; return false
		elseif string.sub(text, at, at + 3) == "null" then at += 4; return nil
		end
		local number = string.match(text, "^-?%d+%.?%d*[eE]?[-+]?%d*", at)
		if not number or number == "" then decodeError(text, at, "unexpected value") end
		at += #number
		return tonumber(number)
	end
	local result = value()
	space()
	if at <= #text then decodeError(text, at, "trailing text") end
	return result
end

local function quote(text)
	return '"' .. string.gsub(text, '[%c"\\]', function(char)
		local named = ({ ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" })[char]
		return named or string.format("\\u%04x", string.byte(char))
	end) .. '"'
end

function json.encode(value)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return tostring(value) end
	if kind == "number" then
		if value ~= value or math.abs(value) == math.huge then error("JSON cannot encode " .. tostring(value), 0) end
		if value == math.floor(value) and math.abs(value) < 2 ^ 53 then return string.format("%.0f", value) end
		return string.format("%.17g", value)
	end
	if kind == "string" then return quote(value) end
	if kind ~= "table" then error("JSON cannot encode a " .. kind, 0) end
	local count = 0
	for _ in value do count += 1 end
	if arrays[value] or (count > 0 and count == #value) then
		local items = {}
		for index = 1, #value do items[index] = json.encode(value[index]) end
		return "[" .. table.concat(items, ",") .. "]"
	end
	local keys = {}
	for key in value do
		if type(key) ~= "string" then error("JSON object keys must be strings", 0) end
		table.insert(keys, key)
	end
	table.sort(keys)
	local items = {}
	for _, key in keys do table.insert(items, quote(key) .. ":" .. json.encode(value[key])) end
	return "{" .. table.concat(items, ",") .. "}"
end

function json.array(value)
	arrays[value] = true
	return value
end
