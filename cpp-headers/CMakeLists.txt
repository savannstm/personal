cmake_minimum_required(VERSION 3.25)

# Check project: every header is compiled alone through a generated wrapper TU so clang-tidy analyzes it, and every
# .cpp is compiled directly. Configure-only; nothing is built or linked.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(cpp-headers LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(ZMIJ_DIR "F:/Repos/zmij" CACHE PATH "")
set(FAST_FLOAT_DIR "F:/Repos/fast_float/include/fast_float" CACHE PATH "")
set(TINYFILEDIALOGS_DIR "F:/Repos/tinyfiledialogs" CACHE PATH "")
set(RELEASE_INCLUDE_DIR "C:/dev/release/include" CACHE PATH "")

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
target_include_directories(cpp_headers_check PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${ZMIJ_DIR}"
    "${FAST_FLOAT_DIR}"
    "${TINYFILEDIALOGS_DIR}"
    "${RELEASE_INCLUDE_DIR}"
    "${RELEASE_INCLUDE_DIR}/QtCore")
target_compile_definitions(cpp_headers_check PRIVATE APP_NAME=\"cpp-headers\")

# Opt-in tests: -DCPP_HEADERS_BUILD_TESTS=ON (ENCHANTUM_DIR is the directory holding enchantum_single_header.hpp).
option(CPP_HEADERS_BUILD_TESTS "Build the header tests" OFF)

if(CPP_HEADERS_BUILD_TESTS)
    set(ENCHANTUM_DIR "F:/Repos/enchantum/single_include/enchantum" CACHE PATH "")
    enable_testing()

    add_executable(cpp_headers_tests tests/Tests.cpp Filesystem.cpp "${ZMIJ_DIR}/zmij.cc")
    target_include_directories(cpp_headers_tests PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}"
        "${ZMIJ_DIR}"
        "${FAST_FLOAT_DIR}"
        "${ENCHANTUM_DIR}")
    add_test(NAME cpp_headers_tests COMMAND cpp_headers_tests)
endif()
