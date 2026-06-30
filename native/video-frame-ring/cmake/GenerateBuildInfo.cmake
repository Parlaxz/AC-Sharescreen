# GenerateBuildInfo.cmake for video-frame-ring
# Simplified version that builds without git provenance.
# cmake-js may invoke cmake without the full source tree context.

if(NOT VFR_SOURCE_DIR)
  set(VFR_SOURCE_DIR "${CMAKE_SOURCE_DIR}")
endif()
if(NOT VFR_BINARY_DIR)
  set(VFR_BINARY_DIR "${CMAKE_BINARY_DIR}")
endif()

set(GIT_COMMIT "unknown")
set(GIT_DIRTY "false")
set(GIT_BRANCH "unknown")
set(BUILD_TIMESTAMP "")
string(TIMESTAMP BUILD_TIMESTAMP UTC)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(BUILD_CONFIG "Debug")
else()
  set(BUILD_CONFIG "Release")
endif()

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(ARCHITECTURE "x64")
else()
  set(ARCHITECTURE "x86")
endif()

set(COMPILER_ID "unknown")
if(MSVC)
  set(COMPILER_ID "MSVC ${CMAKE_CXX_COMPILER_VERSION}")
endif()

# Generate BuildInfo.h
file(READ "${VFR_SOURCE_DIR}/src/BuildInfo.h.in" TEMPLATE)

string(REPLACE "@GIT_COMMIT@" "${GIT_COMMIT}" CONTENT "${TEMPLATE}")
string(REPLACE "@GIT_DIRTY@" "${GIT_DIRTY}" CONTENT "${CONTENT}")
string(REPLACE "@GIT_BRANCH@" "${GIT_BRANCH}" CONTENT "${CONTENT}")
string(REPLACE "@BUILD_TIMESTAMP@" "${BUILD_TIMESTAMP}" CONTENT "${CONTENT}")
string(REPLACE "@ARCHITECTURE@" "${ARCHITECTURE}" CONTENT "${CONTENT}")
string(REPLACE "@BUILD_CONFIG@" "${BUILD_CONFIG}" CONTENT "${CONTENT}")
string(REPLACE "@COMPILER_ID@" "${COMPILER_ID}" CONTENT "${CONTENT}")

file(WRITE "${VFR_BINARY_DIR}/generated/BuildInfo.h" "${CONTENT}")
