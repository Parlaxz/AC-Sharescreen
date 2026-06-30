cmake_minimum_required(VERSION 3.20)
project(screenlink-video-frame-ring
  VERSION 0.1.0
  LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# ─── Architecture check ──────────────────────────────────────────────────────
if(CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "x64 build required. Re-run cmake with -A x64")
endif()

# ─── Strict warnings ─────────────────────────────────────────────────────────
if(MSVC)
  add_compile_options(/W4 /WX /utf-8)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
else()
  add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

# ─── cmake-js setup ─────────────────────────────────────────────────────────
# cmake-js provides CMAKE_JS_INC and CMAKE_JS_LIB variables pointing to
# Node.js/Electron headers and node.lib. We must also link against the
# N-API shared library if needed (cmake-js handles this via node.lib).

# ─── Source files ────────────────────────────────────────────────────────────
set(SOURCES
  src/addon.cpp
  src/FrameRing.cpp
)

# Node native addon module (shared library with .node extension)
add_library(${PROJECT_NAME} SHARED ${SOURCES})

# ─── Include paths ──────────────────────────────────────────────────────────
# cmake-js provides Node.js headers via CMAKE_JS_INC
if(CMAKE_JS_INC)
  target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC})
endif()

# Find node-addon-api headers (installed in the desktop app or via pnpm).
# CMakeLists.txt lives at: native/video-frame-ring/CMakeLists.txt
# Relative paths from CMAKE_SOURCE_DIR (set to native/video-frame-ring by cmake-js):
#   Desktop node_modules: ../apps/desktop/node_modules/node-addon-api
#   Root node_modules:    ../../node_modules/.pnpm/node_modules/node-addon-api
#   pnpm store:           ../../node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api

set(NAPI_SEARCH_PATHS
  "${CMAKE_SOURCE_DIR}/../apps/desktop/node_modules/node-addon-api"
  "${CMAKE_SOURCE_DIR}/../../node_modules/.pnpm/node_modules/node-addon-api"
  "${CMAKE_SOURCE_DIR}/../../node_modules/node-addon-api"
  "${CMAKE_SOURCE_DIR}/../../../node_modules/node-addon-api"
)

# Also search pnpm versioned store via glob
file(GLOB NAPI_PNPM_PATHS
  "${CMAKE_SOURCE_DIR}/../../node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api"
)

foreach(PATH ${NAPI_SEARCH_PATHS} ${NAPI_PNPM_PATHS})
  if(EXISTS "${PATH}/napi.h")
    target_include_directories(${PROJECT_NAME} PRIVATE "${PATH}")
    message(STATUS "Found node-addon-api at: ${PATH}")
    break()
  endif()
endforeach()

# Include generated build-info directory
target_include_directories(${PROJECT_NAME} PRIVATE "${CMAKE_BINARY_DIR}/generated")

# ─── Compile definitions ─────────────────────────────────────────────────────
target_compile_definitions(${PROJECT_NAME} PRIVATE
  $<IF:$<CONFIG:Debug>,_DEBUG,NDEBUG>
)

# ─── Link libraries ──────────────────────────────────────────────────────────
# Windows API (file mapping, events, etc.)
target_link_libraries(${PROJECT_NAME} PRIVATE rpcrt4)

# cmake-js node.lib link flags
if(CMAKE_JS_LIB)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
endif()

# ─── Output naming ──────────────────────────────────────────────────────────
# cmake-js expects the output name to match NODE_GYP_MODULE_NAME
# which defaults to the cmake project name.
# On Windows, rename .dll to .node
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>"
)

# ─── Build provenance header (optional) ─────────────────────────────────────
# Follows the same pattern as video-enhancer and audio-helper
# but simplified since this is a Node addon, not an EXE.
include(cmake/GenerateBuildInfo.cmake OPTIONAL)
