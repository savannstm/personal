# cpp-headers

Non-Qt C++23 utilities, maintained here and copied into each project's `src/utilities/`. Copy the files you need together with their dependencies (below). Qt projects use their own Qt-side equivalents on top of `Numbers.hpp`.

| File | Needs | Notes |
|---|---|---|
| `Aliases.hpp` | - | Qt-free reference. Project `Aliases.hpp` may add more, but must keep these names (`u8`..`i64`, `usize`, `Result`/`Err`, `scast`/`rcast`/`ccast`, `path`, `string_view`, ...). |
| `Numbers.hpp` | `Aliases.hpp`, fast_float, zmij built with `zmij-int.cc` (new: integer `write`, `write_fixed`, `buffer_sizes`) | `Digits` (NUL-terminated, so `data()` is also a C string), `itos`, `htos(value, pad = 0, uppercase = false)`, `ftos(value, precision = -1)`, `stoa` (returns `optional<T>`). Qt side: `../qt-headers`. |
| `StringBuilder.hpp` | `Aliases.hpp`, `Numbers.hpp` | `%` concatenation, `cat`, `append`. |
| `Hasher.hpp` | `Aliases.hpp`, Rust `gxhash` | `Hasher`, `HashMap`, `HashSet`. Hashes by content: any contiguous range of trivially copyable elements (`string`, `string_view`, `QString`, `QStringView`, `vector<u8>`, `array`), otherwise the object's bytes. |
| `Filesystem.hpp/.cpp` | `Aliases.hpp` | `readFile`, `writeFile` returning `Result`. |
| `Logger.hpp/.cpp` | `Aliases.hpp`, `Numbers.hpp`, `StringBuilder.hpp` | Needs `APP_NAME`; optional `APP_SOURCE_ROOT`. `logging::openFile(which, directory)` takes the log directory. |
| `Dialog.hpp/.cpp` | `Aliases.hpp`, `Logger.hpp`, tinyfiledialogs, FLTK | Needs `APP_NAME`. FLTK is used for fallback dialogs and the file pickers. |
| `PackedBits.hpp` | `Aliases.hpp` | Header-only packed bit fields. |

## Compile definitions

- `APP_NAME` - string literal, required by `Logger.cpp` and `Dialog.cpp`. CMake: `target_compile_definitions(app PRIVATE APP_NAME="app")`.
- `APP_SOURCE_ROOT` - string literal, optional. Prefix stripped from file names in log lines.

## gxhash

`Hasher.hpp` declares `extern "C" auto gxhash(const void* ptr, usize len) -> u64;` itself. Export it from the project's tiny `#![no_std]` Rust staticlib (see `revolutionary-audio-player/rust/src/lib.rs`):

```rust
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxhash(ptr: *const c_void, len: usize) -> u64 {
    let bytes: &[u8] = if len == 0 {
        &[]
    } else {
        // SAFETY: the caller guarantees `ptr` is valid for reads of `len` (non-zero) bytes.
        unsafe { core::slice::from_raw_parts(ptr.cast::<u8>(), len) }
    };

    gxhash::gxhash64(bytes, 0)
}
```

Header is hand-written (this declaration); no cbindgen for a gxhash-only crate.
