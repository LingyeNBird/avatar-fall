local plugin = {}

local ELEMENT_ID = "avatar-fall-runtime"
local BUNDLE_PATH = "dist/avatar-fall.bundle.js"

local cached_bundle = nil
local bundle_loaded = false

local function js_quote(value)
    return string.format("%q", value or "")
end

local function escape_script_terminator(code)
    return (code or ""):gsub("</script>", "<\\/script>")
end

local function read_bundle()
    if bundle_loaded and cached_bundle then
        return true, cached_bundle
    end

    local ok, content = pcall(function()
        return sl.fs.read(BUNDLE_PATH)
    end)

    if not ok or not content or content == "" then
        sl.log.error("avatar-fall failed to read runtime bundle: " .. tostring(content))
        return false, nil
    end

    cached_bundle = escape_script_terminator(content)
    bundle_loaded = true
    return true, cached_bundle
end

local function inject_js(js_code)
    local html = "<div data-avatar-fall-runtime=\"1\"></div><script>" .. js_code .. "</script>"
    local ok, result = pcall(function()
        return sl.ui.inject_html(ELEMENT_ID, html)
    end)

    if not ok then
        sl.log.error("avatar-fall inject failed: " .. tostring(result))
        return false
    end

    return true
end

local function route_call_code(route)
    local route_literal = js_quote(route)
    return "if (window.__avatarFallApplyRoute) { window.__avatarFallApplyRoute(" .. route_literal .. "); }"
end

function plugin.onLoad()
    sl.log.info("avatar-fall loaded")
end

function plugin.onEnable()
    local ok_bundle, bundle = read_bundle()
    if not ok_bundle then
        return
    end

    inject_js(bundle .. "\n" .. route_call_code("__INIT__"))
end

function plugin.onPageChanged(path)
    local route = path or ""

    if not bundle_loaded then
        local ok_bundle, bundle = read_bundle()
        if ok_bundle then
            inject_js(bundle .. "\n" .. route_call_code(route))
        end
        return
    end

    inject_js(route_call_code(route))
end

function plugin.onDisable()
    if bundle_loaded then
        inject_js(route_call_code("__DISABLE__"))
    end

    pcall(function()
        sl.ui.remove_html(ELEMENT_ID)
    end)
end

function plugin.onUnload()
    if bundle_loaded then
        inject_js(route_call_code("__UNLOAD__"))
    end

    pcall(function()
        sl.ui.remove_html(ELEMENT_ID)
    end)
end

return plugin
