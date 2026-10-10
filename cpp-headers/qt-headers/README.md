# qt-headers

Qt 6 utilities, maintained here and copied into each Qt project's `src/utilities/`, next to the Qt-free ones from `../cpp-headers` (these headers include `Aliases.hpp`, `Numbers.hpp` from there).

| File | Needs | Notes |
|---|---|---|
| `QtAliases.hpp` | `Aliases.hpp`, Qt Core | `QUtf8SV`, `QL1SV`, `QSVList`, `_qsv` literal, `svtostr` and the Qt < 6.9 `QString + QStringView` operator. Include it from the project's own `Aliases.hpp`. |
| `QtNumbers.hpp` | `QtAliases.hpp`, `Numbers.hpp` | `qitos`, `qhtos`, `qftos` (UTF-16 `Digits<char16_t>`), `qsv`/`qstr` to turn them into a `QStringView`/`QString`, `stoa<T>` for `QStringView`, `QUtf8SV`, `QL1SV` (each returns `optional<T>`). |
| `QtStrings.hpp/.cpp` | `QtAliases.hpp` | `qsvReplace`, `joinQSVList`, `lastPathComponent`, `codePointAt`. |

Examples:

```cpp
u"%1: %2"_s.arg(qsv(qitos(line, 4, '0')), qsv(qftos(ratio, 2)))
u"U+%1"_s.arg(qsv(qhtos(codePoint, 4, true)))   // U+00E9
stoa<u32>(u"ff"_qsv, 16)                         // optional<u32>
```

Qt may be older than 6.9 (stable Debian): keep using `svtostr` where a narrow view goes into `arg`.
