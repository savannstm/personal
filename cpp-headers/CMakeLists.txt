cmake_minimum_required(VERSION 3.25)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(cpp-headers LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(
    zmij
    GIT_REPOSITORY https://github.com/vitaut/zmij
    GIT_TAG main
    GIT_SHALLOW ON
    SYSTEM
    EXCLUDE_FROM_ALL
)
set(ZMIJ_TEST OFF)
set(ZMIJ_EXAMPLE OFF)
FetchContent_MakeAvailable(zmij)
set(ZMIJ_DIR "${zmij_SOURCE_DIR}")

FetchContent_Declare(
    fast_float
    GIT_REPOSITORY https://github.com/fastfloat/fast_float
    GIT_TAG main
    GIT_SHALLOW ON
    SYSTEM
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(fast_float)
set(FAST_FLOAT_DIR "${fast_float_SOURCE_DIR}/include/fast_float")

FetchContent_Declare(
    tinyfiledialogs
    GIT_REPOSITORY https://git.code.sf.net/p/tinyfiledialogs/code
    GIT_TAG master
    GIT_SHALLOW ON
    SYSTEM
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(tinyfiledialogs)
set(TINYFILEDIALOGS_DIR "${tinyfiledialogs_SOURCE_DIR}")

file(GLOB headers CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.hpp")
file(GLOB sources CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp")

set(wrappers)
foreach(header IN LISTS headers)
    get_filename_component(name "${header}" NAME)

    set(wrapper "${CMAKE_CURRENT_BINARY_DIR}/header-checks/${name}.cpp")
    file(WRITE "${wrapper}" "#include \"${header}\"\n")
    list(APPEND wrappers "${wrapper}")
endforeach()

add_library(cpp_headers_check OBJECT ${wrappers} ${sources} "${ZMIJ_DIR}/zmij.cc")
FetchContent_Declare(
    enchantum
    GIT_REPOSITORY https://github.com/ZXShady/enchantum
    GIT_TAG main
    GIT_SHALLOW ON
    SYSTEM
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(enchantum)
set(ENCHANTUM_DIR "${enchantum_SOURCE_DIR}/single_include")

target_include_directories(cpp_headers_check PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${ZMIJ_DIR}"
    "${FAST_FLOAT_DIR}"
    "${TINYFILEDIALOGS_DIR}"
    "${ENCHANTUM_DIR}")
target_compile_definitions(cpp_headers_check PRIVATE APP_NAME=\"cpp-headers\")

find_package(Qt6 REQUIRED COMPONENTS Core)

set(FLTK_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

set(FLTK_BACKEND_X11 ON CACHE BOOL "" FORCE)
set(FLTK_BACKEND_WAYLAND ON CACHE BOOL "" FORCE)

set(FLTK_USE_SYSTEM_ZLIB OFF CACHE BOOL "" FORCE)
set(FLTK_USE_SYSTEM_LIBPNG OFF CACHE BOOL "" FORCE)
set(FLTK_USE_SYSTEM_LIBJPEG OFF CACHE BOOL "" FORCE)

set(FLTK_BUILD_FLUID OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_FLTK_OPTIONS OFF CACHE BOOL "" FORCE)

set(FLTK_BUILD_GL ON CACHE BOOL "" FORCE)
set(FLTK_BUILD_FORMS OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(FLTK_BUILD_HTML_DOCS OFF CACHE BOOL "" FORCE)

set(FLTK_OPTION_CAIRO_WINDOW OFF CACHE BOOL "" FORCE)
set(FLTK_OPTION_CAIRO_EXT OFF CACHE BOOL "" FORCE)
set(FLTK_OPTION_PEN_SUPPORT OFF CACHE BOOL "" FORCE)
set(FLTK_OPTION_LARGE_FILE OFF CACHE BOOL "" FORCE)
set(FLTK_OPTION_PRINT_SUPPORT OFF CACHE BOOL "" FORCE)
set(FLTK_OPTION_FILESYSTEM_SUPPORT ON CACHE BOOL "" FORCE)
set(FLTK_OPTION_STD ON CACHE BOOL "" FORCE)

set(FLTK_USE_XINERAMA OFF CACHE BOOL "" FORCE)
set(FLTK_USE_PTHREADS ON CACHE BOOL "" FORCE)
set(FLTK_USE_XFIXES ON CACHE BOOL "" FORCE)
set(FLTK_USE_XCURSOR OFF CACHE BOOL "" FORCE)
set(FLTK_USE_PANGO OFF CACHE BOOL "" FORCE)
set(FLTK_USE_XFT ON CACHE BOOL "" FORCE)
set(FLTK_USE_XRENDER ON CACHE BOOL "" FORCE)
set(FLTK_USE_DBUS OFF CACHE BOOL "" FORCE)
set(FLTK_USE_POLL OFF CACHE BOOL "" FORCE)
set(FLTK_USE_LIBDECOR_GTK OFF CACHE BOOL "" FORCE)
set(FLTK_USE_SYSTEM_LIBDECOR OFF CACHE BOOL "" FORCE)

set(FLTK_GRAPHICS_CAIRO OFF CACHE BOOL "" FORCE)
set(FLTK_GRAPHICS_GDIPLUS ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    fltk
    GIT_REPOSITORY https://github.com/fltk/fltk
    GIT_TAG master
    GIT_SHALLOW ON
    SYSTEM
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(fltk)

target_link_libraries(cpp_headers_check PRIVATE Qt6::Core fltk::fltk)

option(CPP_HEADERS_BUILD_TESTS "Build the header tests" ON)

if(CPP_HEADERS_BUILD_TESTS)
    enable_testing()

    add_executable(cpp_headers_tests tests/Tests.cpp Filesystem.cpp Logger.cpp QtStrings.cpp "${ZMIJ_DIR}/zmij.cc"
        "${TINYFILEDIALOGS_DIR}/tinyfiledialogs.c")
    if(EXISTS "${ZMIJ_DIR}/zmij-int.cc")
        target_sources(cpp_headers_tests PRIVATE "${ZMIJ_DIR}/zmij-int.cc")
    endif()
    target_include_directories(cpp_headers_tests PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}"
        "${ZMIJ_DIR}"
        "${FAST_FLOAT_DIR}"
        "${TINYFILEDIALOGS_DIR}"
        "${ENCHANTUM_DIR}")
    target_compile_definitions(cpp_headers_tests PRIVATE
        APP_NAME=\"cpp-headers-tests\"
        QT_NO_CAST_FROM_ASCII
        QT_NO_CAST_TO_ASCII)
    target_link_libraries(cpp_headers_tests PRIVATE Qt6::Core fltk::fltk)
    add_test(NAME cpp_headers_tests COMMAND cpp_headers_tests)
endif()
