-- JSON-lines adapter for an unmodified PathOfBuildingCommunity checkout.
-- Run with cwd set to its src/ directory: luajit /path/to/vanilla_stdio_bridge.lua
-- All build operations live in pob_ops.lua (repo-owned); no PoB patches required.
local json = require('dkjson')

-- Locate this script's directory so repo-owned modules load regardless of cwd
local ADAPTER_DIR = (arg and arg[0] or ''):gsub('[^/\\]*$', '')
if ADAPTER_DIR == '' then ADAPTER_DIR = './' end

-- Stock HeadlessWrapper does not define this render stub; define it before the
-- dofile so an upstream version, if one is ever added, takes precedence.
if not GetVirtualScreenSize then
  function GetVirtualScreenSize() return 1920, 1080 end
end

-- The upstream wrapper initializes PoB and exposes newBuild/loadBuildFromXML plus `build`.
dofile('HeadlessWrapper.lua')

-- HeadlessWrapper stubs Inflate() to return "", which makes PoB's timeless jewel
-- loader overwrite its .bin cache with an empty file and skip conquered nodes.
-- Provide a real implementation via the system zlib (LuaJIT FFI).
do
  local ok, err = pcall(function()
    local ffi = require('ffi')
    ffi.cdef[[
      int uncompress(uint8_t *dest, unsigned long *destLen, const uint8_t *source, unsigned long sourceLen);
    ]]
    local zlib
    for _, name in ipairs({ 'z', 'libz.so.1', 'libz.dylib', 'zlib1' }) do
      local loaded, lib = pcall(ffi.load, name)
      if loaded then zlib = lib break end
    end
    if not zlib then error('zlib not found') end
    function Inflate(data)
      if not data or #data == 0 then return '' end
      local size = math.max(#data * 4, 65536)
      while size <= 1024 * 1024 * 1024 do
        local buf = ffi.new('uint8_t[?]', size)
        local len = ffi.new('unsigned long[1]', size)
        local rc = zlib.uncompress(buf, len, data, #data)
        if rc == 0 then return ffi.string(buf, len[0]) end
        if rc ~= -5 then return '' end -- Z_BUF_ERROR means grow and retry
        size = size * 2
      end
      return ''
    end
  end)
  if not ok then
    io.stderr:write('vanilla_stdio_bridge: real Inflate unavailable (' .. tostring(err) .. '); timeless jewels will not be calculated\n')
  end
end


-- json.encode raises on cycles, NaN and functions. An uncaught raise here kills
-- the process and takes the caller's loaded build with it, so a payload we
-- cannot serialise must degrade into an error response, never a crash.
local function reply(value)
  local ok, encoded = pcall(json.encode, value)
  if not ok then
    encoded = json.encode({
      ok = false,
      error = 'response could not be serialised: ' .. tostring(encoded),
    })
  end
  io.write(encoded, '\n')
  io.flush()
end

local handlers = loadfile(ADAPTER_DIR .. 'bridge_handlers.lua')(ADAPTER_DIR)

reply({ ok = true, ready = true, version = { adapter = 'vanilla-stdio-v2' } })
for line in io.lines() do
  local request = json.decode(line)
  -- dkjson happily decodes scalars ("5", "\"ping\""); indexing them would
  -- raise OUTSIDE the handler pcall and kill the bridge — the one failure
  -- mode reply() promises to prevent.
  if type(request) ~= 'table' then
    reply({ ok = false, error = 'invalid request: expected a JSON object' })
  else
    local action, params = request.action, request.params or {}
    if action == 'quit' then
      reply({ ok = true, quit = true })
      break
    end
    local handler = handlers[action]
    if not handler then
      reply({ ok = false, error = 'unknown action: ' .. tostring(action) })
    else
      local ok, res = pcall(handler, params)
      if not ok then
        reply({ ok = false, error = tostring(res) })
      elseif type(res) ~= 'table' then
        reply({ ok = false, error = 'handler returned no response' })
      else
        reply(res)
      end
    end
  end
end
