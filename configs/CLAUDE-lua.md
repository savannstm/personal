# Custom Lua

Helper scripts run on stripped Lua 5.5 fork.

Invocation: `lua.exe script.lua [args...]`;

Absent entirely: package/require/coroutine/debug/math/utf8. Scripts are self-contained.

Available:

- base: assert/dofile/error/getmetatable/ipairs/loadfile/next/pairs/pcall/print/rawequal/rawget/rawlen/rawset/select/setmetatable/tonumber/tostring/type/xpcall/\_G/\_VERSION
- string: byte/char/find/format/gmatch/gsub/len/lower/match/rep/sub/upper (also as methods: s:gsub(...))
- table: concat/insert/remove/sort/unpack
- io: close/flush/open/popen/read/type/write/io.stdin/stdout/stderr; handles have read/write/flush/seek/close/setvbuf
- os: execute/exit/getenv/remove/rename

- Lines: loop on f:read("l") or slurp with f:read("a").
- io.read always reads stdin and io.write always writes stdout; use an io.open handle for files.
- No math: x // 1 for floor/string.format("%d", x) to print integers.

Other:

- LUA_NOCVTN2S: no number->string coercion.
- LUA_NOCVTS2N: no string->number coercion in the VM.
- LUA_32BITS.
